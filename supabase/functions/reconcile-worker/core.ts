/**
 * Edge Function: reconcile-worker (core)
 *
 * 平台↔new-api↔tuzi 三方对账与自动救回的边缘函数版。
 * 每 5 分钟被外部触发一次（服务器 cron curl），函数内部实现：
 *   - 任务锁（reconcile_state 行级 test-and-set，防并发双写）
 *   - 链式间隔：上次完成 + 5 分钟之内直接跳过（间隔不含运行时间）
 *   - 熔断：连续 3 轮异常自动暂停并在恢复时要求 configs.RECONCILE_RESUME=true
 *   - 有活才干活：无新资损目标时轻量返回
 *
 * 与服务器版 reconcile-fix.py 的差异：
 *   - new-api 账本改走本地 new-api 管理 API（/api/log/，边缘函数读不了 SQLite），
 *     凭证 configs.NEWAPI_ACCESS_TOKEN / NEWAPI_USER_ID
 *   - 异步任务恢复路径（new-api tasks 表）未移植，仍由服务器脚本人工兜底
 *
 * 处置规则与服务器版一致：
 *   1. tuzi 有留存（upstream_request_id 精确匹配）→ 下载转存 huabu，任务置
 *      completed；此前已退额的补扣额度
 *   2. 无留存 → 退平台预扣额度 + error.reconciled 标注（幂等防重复退款）
 */

// ---------- 常量 ----------
export const PLATFORM_USERNAME = "chenkaidi";
export const PLATFORM_TOKEN_NAME = "huabu";
export const QUOTA_PER_UNIT = 500000;
export const INTERVAL_MS = 5 * 60 * 1000;
export const STUCK_AFTER_S = 2 * 3600;
export const TOL_BEFORE = 15;
export const TOL_AFTER = 60;
export const MAX_TARGETS_PER_RUN = 10;
export const CIRCUIT_THRESHOLD = 3;
export const LOOKBACK_DAYS = 2;

export interface WorkerEnv {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export interface Deps {
  fetch?: typeof fetch;
  now?: () => number;
}

export interface UpLog {
  logId: number;
  billAt: number;
  useTime: number;
  model: string;
  quota: number;
  upstreamRequestId: string;
  start: number;
}

export interface Task {
  taskId: string;
  userId: string;
  status: string;
  model: string;
  n: number;
  created: number;
  ended: number;
  reconciled: boolean;
  reconcileAction: string;
  err: string;
  logs: UpLog[];
}

export interface RunResult {
  status:
    | "no_work"
    | "skip_lock"
    | "skip_interval"
    | "skip_circuit"
    | "not_configured"
    | "ran"
    | "error";
  message?: string;
  actions?: PlannedAction[];
  consecutiveErrors?: number;
}

interface PlannedAction {
  taskId: string;
  action: "recover" | "recover_recharged" | "refund" | "retry_no_image";
  billed: number;
  via?: string;
  done?: boolean;
  error?: string;
}

interface ReconcileConfig {
  newapiUrl: string;
  newapiAccessToken: string;
  newapiUserId: string;
  tuziToken: string;
  tuziUid: string;
  dingtalkWebhook: string;
  resumeRequested: boolean;
}

// ---------- 基础工具 ----------
export function epochToIso(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

function toEpoch(value: unknown): number {
  if (typeof value === "number") return value;
  return Math.floor(new Date(String(value)).getTime() / 1000);
}

export function extOf(url: string): string {
  const tail = url.split("?")[0].split(".");
  return tail.length > 1 && /^\w{1,5}$/.test(tail[tail.length - 1])
    ? tail[tail.length - 1]
    : "png";
}

function contentTypeOf(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  return map[ext] ?? "application/octet-stream";
}

export function usd(quota: number): string {
  return `$${(quota / QUOTA_PER_UNIT).toFixed(2)}`;
}

async function fetchWithRetry(
  doFetch: typeof fetch,
  url: string,
  attempts = 4,
): Promise<Response> {
  let last: unknown = new Error("no attempt");
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await doFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 reconcile-worker" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp;
    } catch (exc) {
      last = exc;
      await new Promise((r) => setTimeout(r, Math.min(2 ** i * 3000, 20000)));
    }
  }
  throw last;
}

// ---------- PostgREST ----------
async function rest(
  env: WorkerEnv,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const doFetch = fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.serviceRoleKey}`,
    apikey: env.serviceRoleKey,
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  return doFetch(`${env.supabaseUrl}${path}`, { ...init, headers });
}

async function readConfigs(
  env: WorkerEnv,
  keys: string[],
): Promise<Record<string, string>> {
  const resp = await rest(
    env,
    `/rest/v1/configs?key=in.(${keys.map((k) => `"${k}"`).join(",")})&select=key,value`,
  );
  if (!resp.ok) throw new Error(`configs read failed: HTTP ${resp.status}`);
  const rows = (await resp.json()) as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value ?? "";
  return out;
}

// ---------- 状态表：锁 / 链式间隔 / 熔断 ----------
interface ReconcileState {
  running: boolean;
  last_completed_at: string | null;
  consecutive_errors: number;
  circuit_open: boolean;
}

async function readState(env: WorkerEnv): Promise<ReconcileState | null> {
  const resp = await rest(env, "/rest/v1/reconcile_state?id=eq.1&select=*");
  if (!resp.ok) throw new Error(`state read failed: HTTP ${resp.status}`);
  const rows = (await resp.json()) as ReconcileState[];
  return rows[0] ?? null;
}

async function acquireLock(env: WorkerEnv): Promise<boolean> {
  const resp = await rest(
    env,
    "/rest/v1/reconcile_state?id=eq.1&running=eq.false",
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ running: true }),
    },
  );
  if (!resp.ok) throw new Error(`lock failed: HTTP ${resp.status}`);
  const rows = (await resp.json()) as ReconcileState[];
  return rows.length === 1;
}

interface ReleaseOpts {
  completedAt?: string;
  error?: boolean;
  circuitOpen?: boolean;
}

async function releaseLock(
  env: WorkerEnv,
  opts: ReleaseOpts = {},
): Promise<void> {
  const body: Record<string, unknown> = { running: false };
  if (opts.completedAt) body.last_completed_at = opts.completedAt;
  const resp = await rest(env, "/rest/v1/reconcile_state?id=eq.1", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`release failed: HTTP ${resp.status}`);
}

async function bumpErrors(env: WorkerEnv): Promise<ReconcileState> {
  const state = await readState(env);
  const consecutive = (state?.consecutive_errors ?? 0) + 1;
  const open = (state?.circuit_open ?? false) ||
    consecutive >= CIRCUIT_THRESHOLD;
  await rest(env, "/rest/v1/reconcile_state?id=eq.1", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      consecutive_errors: consecutive,
      circuit_open: open,
      running: false,
    }),
  });
  return {
    running: false,
    last_completed_at: state?.last_completed_at ?? null,
    consecutive_errors: consecutive,
    circuit_open: open,
  };
}

async function clearCircuit(env: WorkerEnv): Promise<void> {
  await rest(env, "/rest/v1/reconcile_state?id=eq.1", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ consecutive_errors: 0, circuit_open: false }),
  });
}

// ---------- new-api 账本（管理 API） ----------
export interface NewapiLogRow {
  id: number;
  created_at: number;
  use_time?: number;
  model_name?: string;
  quota?: number;
  username?: string;
  token_name?: string;
  request_id?: string;
  upstream_request_id?: string;
  other?: string;
}

export async function fetchNewapiLogs(
  env: WorkerEnv,
  cfg: ReconcileConfig,
  startEpoch: number,
  endEpoch: number,
  deps: Deps = {},
): Promise<UpLog[]> {
  const doFetch = deps.fetch ?? fetch;
  const url =
    `${cfg.newapiUrl.replace(/\/$/, "")}/api/log/?p=1&page_size=500&type=2` +
    `&start_timestamp=${startEpoch}&end_timestamp=${endEpoch}`;
  const resp = await doFetch(url, {
    headers: {
      Authorization: cfg.newapiAccessToken,
      "New-Api-User": cfg.newapiUserId,
    },
  });
  if (!resp.ok) {
    throw new Error(`new-api log query failed: HTTP ${resp.status}`);
  }
  const payload = (await resp.json()) as
    | { data?: { items?: NewapiLogRow[] } | NewapiLogRow[] }
    | NewapiLogRow[];
  const raw: NewapiLogRow[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data)
      ? payload.data
      : payload.data?.items ?? [];
  return raw
    .filter((r) => r.username === PLATFORM_USERNAME &&
      r.token_name === PLATFORM_TOKEN_NAME)
    .map((r) => ({
      logId: r.id,
      billAt: r.created_at,
      useTime: r.use_time ?? 0,
      model: r.model_name ?? "",
      quota: r.quota ?? 0,
      upstreamRequestId: r.upstream_request_id ?? "",
      start: r.created_at - (r.use_time ?? 0),
    }));
}

// ---------- 匹配：上游开始时间锚定 ----------
export function match(tasks: Task[], logs: UpLog[]): void {
  for (const lg of logs) {
    let best: [number, Task] | null = null;
    for (const t of tasks) {
      if (t.model !== lg.model) continue;
      if (!(t.created - TOL_BEFORE <= lg.start && lg.start <= t.ended + TOL_AFTER)) {
        continue;
      }
      const diff = Math.abs(lg.start - t.created);
      if (best === null || diff < best[0]) best = [diff, t];
    }
    if (best) best[1].logs.push(lg);
  }
}

// ---------- tuzi 留存结果 ----------
export function extractTuziUrls(otherRaw: unknown): string[] {
  let other: Record<string, unknown>;
  try {
    other = typeof otherRaw === "string"
      ? (JSON.parse(otherRaw) as Record<string, unknown>)
      : ((otherRaw as Record<string, unknown>) ?? {});
  } catch {
    return [];
  }
  const delivery = (other.generated_image_delivery ?? {}) as {
    entries?: { url?: string }[];
  };
  const urls = (delivery.entries ?? [])
    .map((e) => e.url ?? "")
    .filter((u) => u.startsWith("http"));
  if (urls.length) return urls;
  const list = other.generated_image_urls;
  if (Array.isArray(list)) {
    return list.filter((u): u is string =>
      typeof u === "string" && u.startsWith("http"));
  }
  const single = other.generated_image_url;
  return typeof single === "string" && single.startsWith("http")
    ? [single]
    : [];
}

export async function tuziFindUrls(
  upstreamRequestId: string,
  billAt: number,
  cfg: ReconcileConfig,
  deps: Deps = {},
): Promise<string[]> {
  if (!upstreamRequestId) return [];
  const doFetch = deps.fetch ?? fetch;
  const url =
    `https://api.tu-zi.com/api/log/self?p=1&page_size=100` +
    `&start_timestamp=${billAt - 180}&end_timestamp=${billAt + 180}`;
  const resp = await doFetch(url, {
    headers: {
      Authorization: cfg.tuziToken,
      "New-Api-User": cfg.tuziUid,
    },
  });
  if (!resp.ok) throw new Error(`tuzi log query failed: HTTP ${resp.status}`);
  const payload = (await resp.json()) as {
    data?: { items?: NewapiLogRow[] } | NewapiLogRow[];
  };
  const items = Array.isArray(payload.data)
    ? payload.data
    : payload.data?.items ?? [];
  for (const row of items) {
    if (row.request_id !== upstreamRequestId) continue;
    return extractTuziUrls(row.other);
  }
  return [];
}

// ---------- 修复动作 ----------
async function patchTask(
  env: WorkerEnv,
  taskId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const resp = await rest(
    env,
    `/rest/v1/task_submissions?task_id=eq.${encodeURIComponent(taskId)}`,
    { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) },
  );
  if (!resp.ok) throw new Error(`task patch failed: HTTP ${resp.status}`);
}

async function callQuotaRpc(
  env: WorkerEnv,
  fn: "refund_image_quota" | "consume_image_quota",
  userId: string,
  count: number,
): Promise<boolean | null> {
  const resp = await rest(env, `/rest/v1/rpc/${fn}`, {
    method: "POST",
    body: JSON.stringify({ p_user_id: userId, p_count: count }),
  });
  if (!resp.ok) return null;
  const text = await resp.text();
  try {
    const parsed = JSON.parse(text) as { consumed?: boolean };
    return typeof parsed?.consumed === "boolean" ? parsed.consumed : null;
  } catch {
    return null;
  }
}

async function performRecovery(
  env: WorkerEnv,
  task: Task,
  urls: string[],
  via: string,
  billed: number,
  prevRefunded: boolean,
  deps: Deps = {},
): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  const uploaded: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const data = await (await fetchWithRetry(doFetch, url)).blob();
    const ext = extOf(url);
    const path = `reconciled/reconciled-${task.taskId.slice(0, 8)}-${i}.${ext}`;
    const putResp = await doFetch(
      `${env.supabaseUrl}/storage/v1/object/huabu/${path}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${env.serviceRoleKey}`,
          "Content-Type": contentTypeOf(ext),
        },
        body: data,
      },
    );
    if (!putResp.ok) {
      throw new Error(`storage upload failed: HTTP ${putResp.status}`);
    }
    uploaded.push(path);
  }

  let quotaRecharged: boolean | null = null;
  if (prevRefunded) {
    quotaRecharged = await callQuotaRpc(
      env,
      "consume_image_quota",
      task.userId,
      task.n,
    );
  }

  const reconciled: Record<string, unknown> = {
    at: new Date().toISOString(),
    action: "result_restored",
    via,
    source_url: urls[0],
    huabu_paths: uploaded,
    upstream_quota: billed,
    original_error: task.err.slice(0, 200),
  };
  if (prevRefunded) {
    reconciled.previously_refunded = true;
    reconciled.quota_recharged = quotaRecharged;
  }
  await patchTask(env, task.taskId, {
    status: "completed",
    result: {
      url: urls[0],
      size: 0,
      format: extOf(urls[0]),
      reconciled,
    },
    response_file_paths: uploaded,
    completed_at: new Date().toISOString(),
    error: null,
  });
}

async function refundAndAnnotate(
  env: WorkerEnv,
  task: Task,
  billed: number,
  reason: string,
): Promise<void> {
  await callQuotaRpc(env, "refund_image_quota", task.userId, task.n);
  const reconciled = {
    at: new Date().toISOString(),
    action: "quota_refunded",
    refunded_count: task.n,
    upstream_quota: billed,
    reason,
  };
  let existing: Record<string, unknown> = {};
  const resp = await rest(
    env,
    `/rest/v1/task_submissions?task_id=eq.${encodeURIComponent(task.taskId)}&select=error`,
  );
  if (resp.ok) {
    const rows = (await resp.json()) as { error: Record<string, unknown> | null }[];
    existing = rows[0]?.error ?? {};
  }
  await patchTask(env, task.taskId, {
    status: "failed",
    error: { ...existing, reconciled },
  });
}

// ---------- 通知 ----------
async function notifyDingtalk(
  webhook: string,
  text: string,
  deps: Deps = {},
): Promise<void> {
  if (!webhook) return;
  const doFetch = deps.fetch ?? fetch;
  try {
    await doFetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { title: "对账救回", text },
      }),
    });
  } catch {
    // 通知失败不影响主流程
  }
}

// ---------- 主流程 ----------
export async function runTick(
  env: WorkerEnv,
  deps: Deps = {},
): Promise<RunResult> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const nowS = now();

  // 熔断与手动恢复
  let state = await readState(env);
  const resumeRequested = (await readConfigs(env, ["RECONCILE_RESUME"]))
    .RECONCILE_RESUME === "true";
  if (state?.circuit_open) {
    if (resumeRequested) {
      await clearCircuit(env);
      state = await readState(env);
    } else {
      return { status: "skip_circuit",
        message: "熔断中；恢复请将 configs.RECONCILE_RESUME 设为 true" };
    }
  }
  if (resumeRequested) {
    // 运维逃生口（一次性）：强制释放孤儿锁并清熔断，随后删除恢复标志，
    // 避免标志残留导致任务锁被永久废掉
    await rest(env, "/rest/v1/reconcile_state?id=eq.1", {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ running: false, circuit_open: false,
        consecutive_errors: 0 }),
    });
    await rest(env, "/rest/v1/configs?key=eq.RECONCILE_RESUME", {
      method: "DELETE",
    });
    state = await readState(env);
  }

  // 任务锁
  if (!(await acquireLock(env))) {
    return { status: "skip_lock", message: "上一轮仍在运行" };
  }

  try {
    // 链式间隔：上次完成 + INTERVAL 之内跳过
    const lastCompleted = state?.last_completed_at
      ? toEpoch(state.last_completed_at) : 0;
    if (lastCompleted && nowS < lastCompleted + INTERVAL_MS / 1000) {
      await releaseLock(env);
      return { status: "skip_interval", message: "距上次完成不足 5 分钟" };
    }

    // 凭证
    const cfgRaw = await readConfigs(env, [
      "NEWAPI_URL", "NEWAPI_ACCESS_TOKEN", "NEWAPI_USER_ID",
      "TUZI_ACCESS_TOKEN", "TUZI_USER_ID", "DEV_DINGTALK_WEBHOOK",
    ]);
    const cfg: ReconcileConfig = {
      newapiUrl: cfgRaw.NEWAPI_URL ?? "",
      newapiAccessToken: cfgRaw.NEWAPI_ACCESS_TOKEN ?? "",
      newapiUserId: cfgRaw.NEWAPI_USER_ID ?? "",
      tuziToken: cfgRaw.TUZI_ACCESS_TOKEN ?? "",
      tuziUid: cfgRaw.TUZI_USER_ID ?? "",
      dingtalkWebhook: cfgRaw.DEV_DINGTALK_WEBHOOK ?? "",
      resumeRequested,
    };
    const configured =
      cfg.newapiUrl && !cfg.newapiAccessToken.startsWith("PENDING") &&
      cfg.newapiUserId && !cfg.newapiUserId.startsWith("PENDING");
    if (!configured) {
      await releaseLock(env, { completedAt: new Date().toISOString() });
      return { status: "not_configured",
        message: "NEWAPI_ACCESS_TOKEN/NEWAPI_USER_ID 未配置，跳过执行" };
    }

    // 数据拉取与匹配
    const lookbackS = LOOKBACK_DAYS * 86400;
    const sinceS = nowS - lookbackS;
    const tasksResp = await rest(
      env,
      `/rest/v1/task_submissions?select=task_id,user_id,type,status,` +
        `params->>model:model,params->>n:n,created_at,completed_at,updated_at,error,` +
        `error->reconciled->>action:reconcile_action` +
        `&created_at=gte.${encodeURIComponent(epochToIso(sinceS - 86400))}` +
        `&order=created_at.desc`,
    );
    if (!tasksResp.ok) {
      throw new Error(`tasks read failed: HTTP ${tasksResp.status}`);
    }
    type TaskRow = {
      task_id: string; user_id: string; type: string; status: string;
      model: string | null; n: number | null;
      created_at: string; completed_at: string | null; updated_at: string;
      error: Record<string, unknown> | null; reconcile_action: string | null;
    };
    const rows = (await tasksResp.json()) as TaskRow[];
    const tasks: Task[] = rows.map((r) => ({
      taskId: r.task_id,
      userId: r.user_id,
      status: r.status,
      model: r.model ?? "",
      n: typeof r.n === "number" && r.n >= 1 ? r.n : 1,
      created: toEpoch(r.created_at),
      ended: toEpoch(r.completed_at ?? r.updated_at),
      reconciled: r.error?.reconciled !== undefined,
      reconcileAction: r.reconcile_action ?? "",
      err: JSON.stringify(r.error ?? {}).slice(0, 200),
      logs: [],
    }));
    const logs = await fetchNewapiLogs(env, cfg, sinceS - 900, nowS, deps);
    match(tasks, logs);

    const targets = tasks.filter((t) =>
      (t.status === "failed" ||
        (t.status === "submitted" && nowS - t.ended > STUCK_AFTER_S)) &&
      t.logs.length > 0
    );

    if (targets.length === 0) {
      await releaseLock(env, { completedAt: new Date().toISOString() });
      return { status: "no_work", message: "近 2 天无待处置资损任务" };
    }

    // 逐个处置（限流保护：单轮最多 MAX_TARGETS_PER_RUN 个）
    const actions: PlannedAction[] = [];
    for (const t of targets.slice(0, MAX_TARGETS_PER_RUN)) {
      const billed = t.logs.reduce((s, lg) => s + lg.quota, 0);
      const prevRefunded = t.reconcileAction === "quota_refunded";
      let urls: string[] = [];
      let via = "";
      if (tuziTokenUsable(cfg)) {
        for (const lg of t.logs) {
          const found = await tuziFindUrls(
            lg.upstreamRequestId, lg.billAt, cfg, deps);
          if (found.length) {
            urls = found;
            via = "tuzi";
            break;
          }
        }
      }
      if (urls.length) {
        try {
          await performRecovery(
            env, t, urls, via, billed, prevRefunded, deps);
          actions.push({ taskId: t.taskId, action: "recover", billed, via, done: true });
        } catch (exc) {
          actions.push({
            taskId: t.taskId, action: "recover", billed, via,
            done: false,
            error: exc instanceof Error ? exc.message : String(exc),
          });
          await refundAndAnnotate(
            env, t, billed,
            `恢复失败: ${exc instanceof Error ? exc.message : String(exc)}`);
          actions.push({ taskId: t.taskId, action: "refund", billed });
        }
      } else if (prevRefunded) {
        actions.push({
          taskId: t.taskId, action: "retry_no_image", billed,
        });
      } else {
        await refundAndAnnotate(env, t, billed, "tuzi 无留存结果");
        actions.push({ taskId: t.taskId, action: "refund", billed });
      }
    }

    await releaseLock(env, { completedAt: new Date().toISOString() });

    // 有动作才报
    const doneActions = actions.filter((a) => a.done !== false);
    if (doneActions.length > 0) {
      const loss = doneActions.reduce((s, a) => s + a.billed, 0);
      const lines = doneActions.slice(0, 10).map((a) =>
        `- \`${a.taskId.slice(0, 8)}\` ${a.action} 上游 ${a.billed}(${usd(a.billed)})` +
        (a.via ? ` via ${a.via}` : "") + (a.done === false ? " 失败" : ""));
      await notifyDingtalk(
        cfg.dingtalkWebhook,
        `### 🔧 对账救回（5 分钟轮）\n- 动作 ${doneActions.length} 项，` +
        `涉及上游额度 ${loss}(${usd(loss)})\n${lines.join("\n")}`,
        deps,
      );
    }
    return { status: "ran", actions };
  } catch (exc) {
    const newState = await bumpErrors(env);
    if (newState.circuit_open &&
        (newState.consecutive_errors ?? 0) === CIRCUIT_THRESHOLD) {
      await notifyDingtalk(
        (await readConfigs(env, ["DEV_DINGTALK_WEBHOOK"])).DEV_DINGTALK_WEBHOOK ??
          "",
        `### ⛔ 对账救回已熔断\n连续 ${newState.consecutive_errors} 轮异常：` +
        `${exc instanceof Error ? exc.message : String(exc)}\n` +
        `人工处理后将 configs.RECONCILE_RESUME 设为 true 恢复`,
        deps,
      );
    }
    return {
      status: "error",
      message: exc instanceof Error ? exc.message : String(exc),
      consecutiveErrors: newState.consecutive_errors,
    };
  }
}

function tuziTokenUsable(cfg: ReconcileConfig): boolean {
  return Boolean(cfg.tuziToken) && Boolean(cfg.tuziUid) &&
    !cfg.tuziToken.startsWith("PENDING");
}

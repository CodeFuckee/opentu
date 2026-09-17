/**
 * dev-monitor Edge Function core logic（纯逻辑，注入 fetch 可单测；不依赖 Deno 全局）
 *
 * 开发监控看板聚合逻辑（与 dashboard-stats 的管理口径分离）：
 * - 服务健康探测：PostgREST / GoTrue / Storage / ai-proxy / New API 网关并行探测，
 *   单探测 5s 超时互不阻塞；ai-proxy 无 JWT 调用返回 401 即视为存活
 * - 任务管线：task_submissions 真实口径（成功率分母含 cancelled、卡死按类型阈值单列），
 *   与用户看板「只看成功任务」的口径刻意不同
 * - 失败样本：最近 50 条 failed 任务的 error 摘要（dev 专用，不上用户看板）
 * - 鉴权：页面为匿名登录壳；/status 要求「有效用户 JWT + is_admin()」（fail-closed）
 */

/** 函数需要的环境注入（由 index.ts 从 Deno.env 读取传入） */
export interface DevMonitorEnv {
  SUPABASE_URL: string;
  SERVICE_ROLE_KEY: string;
  /** 页面 JS 走 GoTrue 登录与 Kong 放行所需的公钥；缺失时函数拒绝启动 */
  ANON_KEY: string;
}

/** 可注入依赖（便于 node:test 单测） */
export interface DevMonitorDeps {
  fetch?: typeof fetch;
}

function baseUrl(env: DevMonitorEnv): string {
  return (env.SUPABASE_URL || '').replace(/\/+$/, '');
}

function srkHeaders(env: DevMonitorEnv): Record<string, string> {
  return {
    apikey: env.SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`,
    Accept: 'application/json',
  };
}

/** 读取 configs 表配置值；读不到返回 null */
async function readConfig(
  env: DevMonitorEnv,
  key: string,
  deps: DevMonitorDeps
): Promise<string | null> {
  const doFetch = deps.fetch || fetch;
  try {
    const response = await doFetch(
      `${baseUrl(env)}/rest/v1/configs?key=eq.${encodeURIComponent(key)}&select=value`,
      { method: 'GET', headers: srkHeaders(env) }
    );
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as Array<{ value?: unknown }>;
    const value = Array.isArray(body) ? body[0]?.value : undefined;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

// ============================================================================
// 健康探测
// ============================================================================

export interface ProbeResult {
  name: string;
  /** true=存活 false=异常 null=未配置（跳过） */
  ok: boolean | null;
  status: string | number;
  latencyMs: number;
  detail: string;
}

const PROBE_TIMEOUT_MS = 5000;

/** 单项探测骨架：超时/网络错误收敛为 down，不拖垮其余探测 */
async function runProbe(
  name: string,
  deps: DevMonitorDeps,
  timeoutMs: number,
  fn: (doFetch: typeof fetch, start: number) => Promise<ProbeResult>
): Promise<ProbeResult> {
  const doFetch = deps.fetch || fetch;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchWithTimeout: typeof fetch = (input, init) =>
    doFetch(input, { ...init, signal: controller.signal });
  try {
    return await fn(fetchWithTimeout, start);
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    return {
      name,
      ok: false,
      status: aborted ? 'timeout' : 'error',
      latencyMs: Date.now() - start,
      detail: aborted ? `超时（>${timeoutMs}ms）` : (error as Error).message.slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 服务健康探测：六项并行，单探测超时默认 5s。
 * - ai-proxy 无 JWT 调 /quota 返回 401 = 函数存活（网关放行、函数在跑）
 * - GoTrue /health 404 时回退 /auth/v1/settings
 * - 网关两项在 configs 缺少 NEWAPI_URL/NEWAPI_TOKEN 时 ok=null（未配置）
 */
export async function probeHealth(
  env: DevMonitorEnv,
  deps: DevMonitorDeps = {},
  opts: { timeoutMs?: number } = {}
): Promise<ProbeResult[]> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const base = baseUrl(env);

  const [newapiUrl, newapiToken] = await Promise.all([
    readConfig(env, 'NEWAPI_URL', deps),
    readConfig(env, 'NEWAPI_TOKEN', deps),
  ]);

  const probes = await Promise.all([
    runProbe('PostgREST', deps, timeoutMs, async (doFetch, start) => {
      const res = await doFetch(`${base}/rest/v1/task_submissions?select=id&limit=1`, {
        headers: srkHeaders(env),
      });
      return { name: 'PostgREST', ok: res.ok, status: res.status, latencyMs: Date.now() - start, detail: res.ok ? '正常' : `HTTP ${res.status}` };
    }),
    runProbe('GoTrue 认证', deps, timeoutMs, async (doFetch, start) => {
      let res = await doFetch(`${base}/auth/v1/health`, { headers: { apikey: env.ANON_KEY } });
      let fellback = false;
      if (!res.ok) {
        res = await doFetch(`${base}/auth/v1/settings`, { headers: { apikey: env.ANON_KEY } });
        fellback = true;
      }
      return {
        name: 'GoTrue 认证',
        ok: res.ok,
        status: res.status,
        latencyMs: Date.now() - start,
        detail: res.ok ? (fellback ? '正常（/health 不可用，经 /settings）' : '正常') : `HTTP ${res.status}`,
      };
    }),
    runProbe('Storage', deps, timeoutMs, async (doFetch, start) => {
      const res = await doFetch(`${base}/storage/v1/status`, { headers: { apikey: env.ANON_KEY } });
      return { name: 'Storage', ok: res.ok, status: res.status, latencyMs: Date.now() - start, detail: res.ok ? '正常' : `HTTP ${res.status}` };
    }),
    runProbe('ai-proxy 函数', deps, timeoutMs, async (doFetch, start) => {
      const res = await doFetch(`${base}/functions/v1/ai-proxy/quota`);
      // 401 = 网关放行且函数存活（未带 JWT 被函数门禁拒绝）
      const alive = res.ok || res.status === 401 || res.status === 403;
      return {
        name: 'ai-proxy 函数',
        ok: alive,
        status: res.status,
        latencyMs: Date.now() - start,
        detail: alive ? (res.status === 401 ? '存活（未带 JWT 被 401 拒绝）' : '正常') : `HTTP ${res.status}`,
      };
    }),
    runProbe('New API 网关', deps, timeoutMs, async (doFetch, start) => {
      if (!newapiUrl) {
        return { name: 'New API 网关', ok: null, status: 'skipped', latencyMs: 0, detail: 'configs 缺少 NEWAPI_URL 配置，未探测' };
      }
      const res = await doFetch(`${newapiUrl.replace(/\/+$/, '')}/api/status`);
      return { name: 'New API 网关', ok: res.ok, status: res.status, latencyMs: Date.now() - start, detail: res.ok ? '正常' : `HTTP ${res.status}` };
    }),
    runProbe('网关管理令牌', deps, timeoutMs, async (doFetch, start) => {
      if (!newapiUrl || !newapiToken) {
        return { name: '网关管理令牌', ok: null, status: 'skipped', latencyMs: 0, detail: 'configs 缺少 NEWAPI_URL/NEWAPI_TOKEN 配置，未探测' };
      }
      const res = await doFetch(`${newapiUrl.replace(/\/+$/, '')}/api/token/?p=1&size=1`, {
        headers: { Authorization: `Bearer ${newapiToken}` },
      });
      return { name: '网关管理令牌', ok: res.ok, status: res.status, latencyMs: Date.now() - start, detail: res.ok ? '有效' : `HTTP ${res.status}（令牌失效？）` };
    }),
  ]);
  return probes;
}

// ============================================================================
// 任务管线聚合
// ============================================================================

export interface PipelineRow {
  user_id?: string;
  type: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  model?: string;
}

export interface PipelineCounts {
  completed: number;
  failed: number;
  cancelled: number;
  submitted: number;
  stuck: number;
}

export interface DurationStat {
  count: number;
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
}

export interface ModelFailStat {
  model: string;
  failed: number;
  /** 终态任务数（completed+failed+cancelled，卡死不计入分母） */
  total: number;
  rate: number;
}

export interface DailyTrendPoint {
  date: string;
  total: number;
  failed: number;
}

export interface PipelineStats {
  counts: PipelineCounts;
  /** completed / (completed+failed+cancelled)，分母 0 为 null */
  successRate: number | null;
  durationByType: Record<string, DurationStat>;
  failuresByModel: ModelFailStat[];
  daily: DailyTrendPoint[];
}

/** 业务统计时区：用户群在国内，按东八区切日 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 卡死阈值（毫秒）：image 10 分钟、video 30 分钟、其余 10 分钟 */
const STUCK_THRESHOLDS_MS: Record<string, number> = {
  image: 10 * 60_000,
  video: 30 * 60_000,
};

export function stuckThresholdMs(type: string): number {
  return STUCK_THRESHOLDS_MS[type] ?? 10 * 60_000;
}

function localDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return null;
  }
  return new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1;
  return sorted[index];
}

/** 任务管线聚合：真实口径（成功率分母含 cancelled；卡死单列不计入分母） */
export function aggregatePipeline(rows: PipelineRow[], nowMs: number = Date.now()): PipelineStats {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let submitted = 0;
  let stuck = 0;

  const durationsByType = new Map<string, number[]>();
  const totalByModel = new Map<string, number>();
  const failedByModel = new Map<string, number>();
  const dailyMap = new Map<string, DailyTrendPoint>();

  for (const row of rows) {
    switch (row.status) {
      case 'completed': completed += 1; break;
      case 'failed': failed += 1; break;
      case 'cancelled': cancelled += 1; break;
      case 'submitted':
        submitted += 1;
        if (nowMs - Date.parse(row.created_at) > stuckThresholdMs(row.type)) {
          stuck += 1;
        }
        break;
      default:
        break;
    }

    if (row.status === 'completed' && row.created_at && row.completed_at) {
      const created = Date.parse(row.created_at);
      const done = Date.parse(row.completed_at);
      if (Number.isFinite(created) && Number.isFinite(done)) {
        const list = durationsByType.get(row.type) ?? [];
        list.push(Math.max(0, done - created));
        durationsByType.set(row.type, list);
      }
    }

    const model = (row.model || '').trim();
    if (model && row.status !== 'submitted') {
      totalByModel.set(model, (totalByModel.get(model) ?? 0) + 1);
      if (row.status === 'failed') {
        failedByModel.set(model, (failedByModel.get(model) ?? 0) + 1);
      }
    }

    const date = row.created_at ? localDate(row.created_at) : null;
    if (date) {
      const point = dailyMap.get(date) ?? { date, total: 0, failed: 0 };
      point.total += 1;
      if (row.status === 'failed') {
        point.failed += 1;
      }
      dailyMap.set(date, point);
    }
  }

  const denominator = completed + failed + cancelled;
  const successRate = denominator > 0 ? Math.round((completed / denominator) * 10000) / 10000 : null;

  const durationByType: Record<string, DurationStat> = {};
  for (const [type, list] of durationsByType) {
    const sorted = [...list].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    durationByType[type] = {
      count: sorted.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      avgMs: Math.round(sum / sorted.length),
    };
  }

  const failuresByModel: ModelFailStat[] = Array.from(totalByModel.entries()).map(([model, total]) => {
    const failedCount = failedByModel.get(model) ?? 0;
    return {
      model,
      failed: failedCount,
      total,
      rate: total > 0 ? Math.round((failedCount / total) * 10000) / 10000 : 0,
    };
  }).sort((a, b) => b.failed - a.failed || b.total - a.total);

  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return { counts: { completed, failed, cancelled, submitted, stuck }, successRate, durationByType, failuresByModel, daily };
}

// ============================================================================
// 失败样本与卡死列表
// ============================================================================

export interface FailureRow {
  user_id?: string;
  type: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  model?: string;
  error?: unknown;
}

export interface FailureSample {
  createdAt: string | null;
  oa: string | null;
  type: string;
  model: string | null;
  durationMs: number | null;
  errorSummary: string;
}

/** error jsonb → 一行摘要：message 优先，error 字符串次之，对象 JSON 截断 */
export function summarizeError(error: unknown, maxLen = 200): string {
  let text = '';
  if (typeof error === 'string') {
    text = error.trim();
  } else if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) {
      text = record.message.trim();
    } else if (typeof record.error === 'string' && record.error.trim()) {
      text = record.error.trim();
    } else {
      try {
        const json = JSON.stringify(error);
        if (json && json !== '{}' && json !== '[]') {
          text = json;
        }
      } catch {
        text = String(error);
      }
    }
  } else if (error != null) {
    text = String(error);
  }
  return text.slice(0, maxLen);
}

export function toFailureSamples(
  rows: FailureRow[],
  oaByUser: Map<string, string>
): FailureSample[] {
  return rows.map((row) => {
    const created = row.created_at ? Date.parse(row.created_at) : Number.NaN;
    const done = row.completed_at ? Date.parse(row.completed_at) : Number.NaN;
    return {
      createdAt: row.created_at || null,
      oa: (row.user_id && oaByUser.get(row.user_id)) || null,
      type: row.type,
      model: (row.model || '').trim() || null,
      durationMs: Number.isFinite(created) && Number.isFinite(done) ? Math.max(0, done - created) : null,
      errorSummary: summarizeError(row.error),
    };
  });
}

export interface StuckItem {
  createdAt: string | null;
  oa: string | null;
  type: string;
  model: string | null;
  waitedMs: number;
  thresholdMs: number;
}

/** 卡死任务列表：submitted 且超过类型阈值，按等待时长倒序，最多 20 条 */
export function toStuckList(
  rows: PipelineRow[],
  oaByUser: Map<string, string>,
  nowMs: number = Date.now()
): StuckItem[] {
  const items: StuckItem[] = [];
  for (const row of rows) {
    if (row.status !== 'submitted' || !row.created_at) {
      continue;
    }
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created)) {
      continue;
    }
    const waited = nowMs - created;
    const threshold = stuckThresholdMs(row.type);
    if (waited > threshold) {
      items.push({
        createdAt: row.created_at,
        oa: (row.user_id && oaByUser.get(row.user_id)) || null,
        type: row.type,
        model: (row.model || '').trim() || null,
        waitedMs: waited,
        thresholdMs: threshold,
      });
    }
  }
  return items.sort((a, b) => b.waitedMs - a.waitedMs).slice(0, 20);
}

// ============================================================================
// 状态编排（/status 数据生产者）
// ============================================================================

export interface DevStatus {
  generatedAt: string;
  days: number;
  probes: ProbeResult[];
  /** 窗口任务行拉取失败时为 null（页面显示拉取失败，探测结果仍然可用） */
  pipeline: PipelineStats | null;
  recentFailures: FailureSample[];
  stuckList: StuckItem[];
}

async function fetchJsonRows(
  env: DevMonitorEnv,
  path: string,
  deps: DevMonitorDeps
): Promise<unknown[] | null> {
  const doFetch = deps.fetch || fetch;
  try {
    const response = await doFetch(`${baseUrl(env)}${path}`, { headers: srkHeaders(env) });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? body : [];
  } catch {
    return null;
  }
}

function clampDays(days: unknown): number {
  const n = typeof days === 'string' ? Number(days) : Number(days) || 7;
  if (!Number.isFinite(n)) {
    return 7;
  }
  return Math.min(Math.max(Math.round(n), 1), 90);
}

/** 聚合完整开发状态：探测与数据查询并行，单块失败降级不拖垮整体（60s 函数超时内完成） */
export async function aggregateStatus(
  env: DevMonitorEnv,
  days: number,
  deps: DevMonitorDeps = {}
): Promise<DevStatus> {
  const safeDays = clampDays(days);
  const fromIso = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const windowQuery =
    `/rest/v1/task_submissions?select=id,user_id,type,status,created_at,completed_at,model:params-%3E%3Emodel&created_at=gte.${encodeURIComponent(fromIso)}&order=created_at.asc&limit=20000`;
  const failureQuery =
    `/rest/v1/task_submissions?select=created_at,completed_at,user_id,type,error,model:params-%3E%3Emodel&status=eq.failed&created_at=gte.${encodeURIComponent(fromIso)}&order=created_at.desc&limit=50`;

  const [windowRows, failureRows, profileRows, probes] = await Promise.all([
    fetchJsonRows(env, windowQuery, deps),
    fetchJsonRows(env, failureQuery, deps),
    fetchJsonRows(env, `/rest/v1/user_profiles?select=user_id,oa_account&limit=50000`, deps),
    probeHealth(env, deps),
  ]);

  const oaByUser = new Map<string, string>(
    (profileRows ?? []).map((p) => {
      const row = p as { user_id?: unknown; oa_account?: unknown };
      return [
        typeof row.user_id === 'string' ? row.user_id : '',
        typeof row.oa_account === 'string' ? row.oa_account : '',
      ];
    }).filter(([id]) => id !== '')
  );

  return {
    generatedAt: new Date().toISOString(),
    days: safeDays,
    probes,
    pipeline: windowRows ? aggregatePipeline(windowRows as PipelineRow[]) : null,
    recentFailures: toFailureSamples((failureRows ?? []) as FailureRow[], oaByUser),
    stuckList: toStuckList((windowRows ?? []) as PipelineRow[], oaByUser),
  };
}

// ============================================================================
// 管理员门禁（与 dashboard-stats 同语义：调用者 JWT + is_admin RPC）
// ============================================================================

/** 从 Authorization 头提取 Bearer token（无/格式不符返回 null） */
export function extractBearerToken(headerValue: string | null): string | null {
  const match = (headerValue || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export type DevGate =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string };

/** 门禁：有效用户 JWT（/auth/v1/user 自证）+ is_admin() RPC；失败 fail-closed 403 */
export async function verifyDevAdmin(
  env: DevMonitorEnv,
  request: Request,
  deps: DevMonitorDeps = {}
): Promise<DevGate> {
  const jwt = extractBearerToken(request.headers.get('Authorization'));
  if (!jwt) {
    return { ok: false, status: 401, error: 'unauthorized: missing bearer token' };
  }
  const doFetch = deps.fetch || fetch;
  const base = baseUrl(env);
  try {
    const authRes = await doFetch(`${base}/auth/v1/user`, {
      method: 'GET',
      headers: { apikey: env.SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!authRes.ok) {
      return { ok: false, status: 401, error: 'unauthorized: invalid token' };
    }
    const rpcRes = await doFetch(`${base}/rest/v1/rpc/is_admin`, {
      method: 'POST',
      headers: {
        apikey: env.SERVICE_ROLE_KEY,
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!rpcRes.ok) {
      return { ok: false, status: 403, error: 'forbidden: admin only' };
    }
    const verdict = (await rpcRes.json().catch(() => false)) === true;
    if (verdict) return { ok: true };
    return { ok: false, status: 403, error: 'forbidden: admin only' };
  } catch {
    return { ok: false, status: 403, error: 'forbidden: admin only' };
  }
}

// ============================================================================
// HTML 开发监控页面（自包含，无外部依赖）
// ============================================================================

/**
 * 生成自包含开发监控页面。页面 JS 以相对路径调 `status?days=N`，
 * 数据请求带登录会话的 access_token（oa账号+密码登录，30s 自动刷新可开关）。
 */
export function buildDevMonitorHtml(anonKey: string): string {
  const safeKey = anonKey.replace(/[<>&'"]/g, '');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>开发监控 · YUE 画布</title>
<style>
  :root { --bg:#070b16; --card:rgba(255,255,255,.035); --card2:rgba(148,163,184,.09); --line:rgba(148,163,184,.14); --text:#e8eefc; --muted:#8b98b3; --accent:#5b8cff; --accent2:#22d3ee; --ok:#34d399; --fail:#f87171; --warn:#fbbf24; --radius:14px; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; -webkit-font-smoothing:antialiased; padding:0 0 36px; }
  header { position:sticky; top:0; z-index:10; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
    padding:14px 26px; background:rgba(7,11,22,.74); backdrop-filter:blur(12px); border-bottom:1px solid var(--line); }
  h1 { font-size:17px; font-weight:700; letter-spacing:.5px; background:linear-gradient(90deg,#a5c4ff,#22d3ee); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .wrap { max-width:1280px; margin:0 auto; padding:6px 26px 0; }
  .controls { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  button, select, label { background:rgba(148,163,184,.1); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 12px; font-size:13px; }
  button { cursor:pointer; transition:.15s; }
  button:hover { border-color:var(--accent); background:rgba(91,140,255,.12); }
  label { display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; }
  .meta { color:var(--muted); font-size:12px; }
  .panel { background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.015)); border:1px solid var(--line);
    border-radius:var(--radius); padding:18px; margin-bottom:14px; animation:fadeUp .45s ease both; }
  .panel h2 { font-size:13px; font-weight:600; margin-bottom:14px; display:flex; align-items:center; gap:8px; }
  .panel h2::before { content:''; width:3px; height:12px; border-radius:2px; background:linear-gradient(180deg,var(--accent),var(--accent2)); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(175px,1fr)); gap:14px; }
  .card { background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015)); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card .label { color:var(--muted); font-size:12px; margin-bottom:8px; }
  .card .value { font-size:24px; font-weight:700; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
  .card .sub { color:var(--muted); font-size:12px; margin-top:6px; overflow-wrap:anywhere; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:7px; }
  .dot.up { background:var(--ok); box-shadow:0 0 8px rgba(52,211,153,.8); }
  .dot.down { background:var(--fail); box-shadow:0 0 8px rgba(248,113,113,.8); }
  .dot.skip { background:var(--muted); }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(380px,1fr)); gap:14px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid rgba(148,163,184,.09); }
  th { color:var(--muted); font-weight:500; white-space:nowrap; }
  tbody tr:hover { background:rgba(91,140,255,.07); }
  td.err { color:var(--fail); max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:12px; }
  .bar-row .name { width:150px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--muted); }
  .bar-row .track { flex:1; height:12px; background:var(--card2); border-radius:6px; overflow:hidden; }
  .bar-row .fill { height:100%; background:linear-gradient(90deg,#f87171,#fbbf24); border-radius:6px; }
  .bar-row .num { width:130px; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .muted { color:var(--muted); }
  .sk { min-height:80px; border-radius:10px; background:linear-gradient(100deg,rgba(255,255,255,.04) 30%,rgba(255,255,255,.09) 50%,rgba(255,255,255,.04) 70%); background-size:200% 100%; animation:shimmer 1.2s linear infinite; }
  @keyframes shimmer { to { background-position:-200% 0; } }
  @keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  .error { color:var(--fail); padding:20px; text-align:center; }
  #loginCard { position:fixed; inset:0; z-index:60; display:none; align-items:center; justify-content:center;
    background:radial-gradient(720px 360px at 50% 18%, rgba(91,140,255,.14), transparent 65%), var(--bg); }
  #loginCard .login-box { width:min(360px,92vw); background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:28px 26px; }
  #loginCard h1 { font-size:17px; margin-bottom:6px; }
  #loginCard .sub { color:var(--muted); font-size:12px; margin-bottom:18px; }
  #loginCard input { width:100%; background:rgba(148,163,184,.1); color:var(--text); border:1px solid var(--line);
    border-radius:8px; padding:9px 12px; font-size:13px; margin-bottom:10px; outline:none; }
  #loginBtn { width:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); color:#fff; border:none;
    border-radius:8px; padding:10px 12px; font-size:13px; font-weight:600; cursor:pointer; }
  #loginMsg { color:var(--fail); font-size:12px; min-height:16px; margin-top:10px; text-align:center; }
</style>
</head>
<body>
<header>
  <h1>YUE 画布开发监控</h1>
  <div class="controls">
    <span class="meta" id="generatedAt"></span>
    <select id="daysSel">
      <option value="1">今日（近 1 天）</option>
      <option value="7" selected>近 7 天</option>
      <option value="14">近 14 天</option>
      <option value="30">近 30 天</option>
    </select>
    <label title="每 30 秒自动刷新"><input type="checkbox" id="autoRefresh" checked> 自动刷新</label>
    <button id="refreshBtn">刷新</button>
    <button id="logoutBtn" title="退出登录">退出</button>
  </div>
</header>
<div class="wrap">

<div class="panel"><h2>服务健康</h2><div class="cards" id="probeGrid"><div class="sk"></div></div></div>

<div class="panel"><h2>任务管线（真实口径：成功率分母含 cancelled，卡死单列）</h2><div class="cards" id="pipeCards"><div class="sk"></div></div></div>

<div class="grid2">
  <div class="panel"><h2>按模型失败排行</h2><div id="modelFailBars"><div class="sk"></div></div></div>
  <div class="panel"><h2>按天归档趋势（total / failed）</h2><table id="dailyTable"><thead><tr><th>日期</th><th>归档任务</th><th>失败</th><th>失败率</th></tr></thead><tbody></tbody></table></div>
</div>

<div class="panel"><h2>失败样本（最近 50 条，含报错摘要）</h2><table id="failTable"><thead><tr><th>时间</th><th>用户</th><th>类型</th><th>模型</th><th>耗时</th><th>错误</th></tr></thead><tbody></tbody></table></div>

<div class="panel"><h2>卡死任务（submitted 超过类型阈值：image 10 分钟 / video 30 分钟 / 其余 10 分钟）</h2><table id="stuckTable"><thead><tr><th>创建时间</th><th>用户</th><th>类型</th><th>模型</th><th>已等待</th><th>阈值</th></tr></thead><tbody></tbody></table></div>

</div>

<div id="loginCard">
  <div class="login-box">
    <h1>YUE 画布开发监控</h1>
    <div class="sub">仅开发管理员可见，请使用平台账号（oa账号）登录</div>
    <input id="loginAccount" placeholder="oa账号（小写）" autocomplete="username">
    <input id="loginPassword" type="password" placeholder="密码" autocomplete="current-password">
    <button id="loginBtn">登录</button>
    <div id="loginMsg"></div>
  </div>
</div>

<script>
var ANON_KEY = "${safeKey}";
var days = 7;
var REFRESH_MS = 30000;
var refreshTimer = null;

// ==================== 登录会话（与 dashboard-stats 同语义） ====================
var SESSION_KEY = 'dev_monitor_session';
var session = null;

function loadSession(){ try{ session = JSON.parse(localStorage.getItem(SESSION_KEY)||'null'); }catch(e){ session=null; } if(!session||!session.access_token) session=null; }
function saveSession(s){ session=s; try{ localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }catch(e){} }
function clearSession(){ session=null; try{ localStorage.removeItem(SESSION_KEY); }catch(e){} }
function normalizeAccount(acc){ acc=(acc||'').trim(); if(!acc) return ''; return acc.indexOf('@')>=0 ? acc : acc.toLowerCase()+'@yjk.com'; }
function showLogin(){ document.getElementById('loginCard').style.display='flex'; }
function hideLogin(){ document.getElementById('loginCard').style.display='none'; }
function showLoginMsg(text){ document.getElementById('loginMsg').textContent=text||''; }

function doLogin(){
  var account = document.getElementById('loginAccount').value;
  var password = document.getElementById('loginPassword').value;
  var email = normalizeAccount(account);
  if(!email || !password){ showLoginMsg('请输入 oa账号与密码'); return; }
  var btn = document.getElementById('loginBtn');
  btn.disabled = true; showLoginMsg('');
  fetch('/auth/v1/token?grant_type=password', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'apikey':ANON_KEY },
    body: JSON.stringify({ email: email, password: password })
  }).then(function(r){ return r.json().then(function(j){ return { ok:r.ok, body:j }; }); })
    .then(function(res){
      btn.disabled = false;
      if(res.ok && res.body && res.body.access_token){
        saveSession({ access_token:res.body.access_token, refresh_token:res.body.refresh_token });
        showLoginMsg(''); hideLogin(); load(); setupAutoRefresh();
      } else {
        showLoginMsg('账号或密码错误（或账号未注册）');
      }
    })
    .catch(function(){ btn.disabled = false; showLoginMsg('登录请求失败，请检查网络'); });
}

function tryRefresh(){
  if(!session || !session.refresh_token) return Promise.resolve(false);
  return fetch('/auth/v1/token?grant_type=refresh_token', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'apikey':ANON_KEY },
    body: JSON.stringify({ refresh_token: session.refresh_token })
  }).then(function(r){ return r.json().then(function(j){ return { ok:r.ok, body:j }; }); })
    .then(function(res){
      if(res.ok && res.body && res.body.access_token){
        saveSession({ access_token:res.body.access_token, refresh_token:res.body.refresh_token||session.refresh_token });
        return true;
      }
      clearSession(); return false;
    })
    .catch(function(){ return false; });
}

function authHeaders(extra){
  var h = extra || {};
  if(session && session.access_token) h['Authorization'] = 'Bearer ' + session.access_token;
  return h;
}

function fmtDate(iso){ if(!iso) return '-'; var d=new Date(iso); if(isNaN(d)) return String(iso); var p=function(x){return String(x).padStart(2,'0')}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
function fmtDur(ms){ if(ms==null) return '-'; if(!ms) return '0 秒'; var s=ms/1000; if(s<60) return Math.round(s)+' 秒'; if(s<3600) return (s/60).toFixed(1)+' 分钟'; return (s/3600).toFixed(1)+' 小时'; }
function esc(s){ return String(s==null?'-':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function pct(rate){ return rate==null ? '-' : (rate*100).toFixed(1)+'%'; }

function renderProbes(probes){
  var el = document.getElementById('probeGrid');
  el.innerHTML = (probes||[]).map(function(p){
    var cls = p.ok===true ? 'up' : p.ok===false ? 'down' : 'skip';
    var stateText = p.ok===true ? '正常' : p.ok===false ? '异常' : '未探测';
    return '<div class="card"><div class="label"><span class="dot '+cls+'"></span>'+esc(p.name)+'</div>'+
      '<div class="value" style="font-size:16px">'+esc(stateText)+'</div>'+
      '<div class="sub">'+esc(p.detail)+' · '+p.latencyMs+'ms</div></div>';
  }).join('') || '<div class="muted">暂无数据</div>';
}

function renderPipeline(o){
  var el = document.getElementById('pipeCards');
  var p = o.pipeline;
  if(!p){ el.innerHTML = '<div class="card" style="grid-column:1/-1"><div class="error">任务管线数据拉取失败（task_submissions 不可达或超时）</div></div>'; return; }
  var c = p.counts;
  var img = p.durationByType && p.durationByType.image;
  var imgLine = img ? ('出图 p50 '+fmtDur(img.p50Ms)+' / p95 '+fmtDur(img.p95Ms)+' / n='+img.count) : '暂无完成样本';
  var cards = [
    ['成功率', pct(p.successRate), 'completed / (completed+failed+cancelled)'],
    ['成功 / 失败', c.completed+' / '+c.failed, 'cancelled '+c.cancelled+' 单列，不计入失败'],
    ['卡死任务', c.stuck, 'submitted 超时未终态（当前 '+c.submitted+' 条未完成）'],
    ['出图耗时', img ? fmtDur(img.p50Ms)+' / '+fmtDur(img.p95Ms) : '-', 'p50 / p95 · '+imgLine],
  ];
  el.innerHTML = cards.map(function(card){
    return '<div class="card"><div class="label">'+esc(card[0])+'</div><div class="value">'+esc(card[1])+'</div><div class="sub">'+esc(card[2])+'</div></div>';
  }).join('');

  // 按模型失败排行
  var bars = (p.failuresByModel||[]).slice(0, 10);
  var maxRate = 1;
  document.getElementById('modelFailBars').innerHTML = bars.length ? bars.map(function(m){
    var w = Math.max(2, Math.round(m.rate/maxRate*100));
    return '<div class="bar-row"><span class="name" title="'+esc(m.model)+'">'+esc(m.model)+'</span>'+
      '<div class="track"><div class="fill" style="width:'+w+'%"></div></div>'+
      '<span class="num">'+m.failed+'/'+m.total+'（'+pct(m.rate)+'）</span></div>';
  }).join('') : '<div class="muted">暂无数据</div>';

  // 按天趋势
  var dailyRows = (p.daily||[]).slice(-14).reverse();
  document.querySelector('#dailyTable tbody').innerHTML = dailyRows.length ? dailyRows.map(function(d){
    return '<tr><td>'+esc(d.date)+'</td><td>'+d.total+'</td><td>'+(d.failed?'<span style="color:var(--fail)">'+d.failed+'</span>':'0')+'</td><td>'+pct(d.total?d.failed/d.total:null)+'</td></tr>';
  }).join('') : '<tr><td colspan="4" class="muted">暂无数据</td></tr>';
}

function renderFailures(list){
  var rows = (list||[]).map(function(f){
    return '<tr><td>'+fmtDate(f.createdAt)+'</td><td>'+esc(f.oa||'-')+'</td><td>'+esc(f.type)+'</td><td>'+esc(f.model||'-')+'</td><td>'+fmtDur(f.durationMs)+'</td><td class="err" title="'+esc(f.errorSummary)+'">'+esc(f.errorSummary||'-')+'</td></tr>';
  }).join('');
  document.querySelector('#failTable tbody').innerHTML = rows || '<tr><td colspan="6" class="muted">窗口内暂无失败任务 🎉</td></tr>';
}

function renderStuck(list){
  var rows = (list||[]).map(function(s){
    return '<tr><td>'+fmtDate(s.createdAt)+'</td><td>'+esc(s.oa||'-')+'</td><td>'+esc(s.type)+'</td><td>'+esc(s.model||'-')+'</td><td style="color:var(--warn)">'+fmtDur(s.waitedMs)+'</td><td class="muted">'+fmtDur(s.thresholdMs)+'</td></tr>';
  }).join('');
  document.querySelector('#stuckTable tbody').innerHTML = rows || '<tr><td colspan="6" class="muted">没有卡死任务 👍</td></tr>';
}

function render(o){
  document.getElementById('generatedAt').textContent = '统计窗口 近 '+o.days+' 天 · 生成于 ' + fmtDate(o.generatedAt);
  renderProbes(o.probes);
  renderPipeline(o);
  renderFailures(o.recentFailures);
  renderStuck(o.stuckList);
}

function basePath(){
  var p = location.pathname.replace(/\\/+$/, '');
  p = p.replace(/\\/index\\.html$/, '');
  return p + '/';
}

async function load(){
  days = Number(document.getElementById('daysSel').value) || 7;
  var requestStatus = function(){
    return fetch(basePath() + 'status?days=' + days, { headers: authHeaders() });
  };
  try {
    var res = await requestStatus();
    if(res.status===401){
      if(await tryRefresh()){ res = await requestStatus(); }
      if(res.status===401){ clearSession(); showLogin(); return; }
    }
    if(res.status===403){
      throw new Error('仅开发管理员可查看本页（当前账号未授权）');
    }
    if(!res.ok){ throw new Error('HTTP ' + res.status); }
    render(await res.json());
  } catch(err){
    document.getElementById('pipeCards').innerHTML =
      '<div class="card" style="grid-column:1/-1"><div class="error">加载失败：'+esc(err && err.message ? err.message : err)+'</div></div>';
  }
}

function setupAutoRefresh(){
  var checkbox = document.getElementById('autoRefresh');
  if(refreshTimer){ clearInterval(refreshTimer); refreshTimer = null; }
  if(checkbox.checked){ refreshTimer = setInterval(load, REFRESH_MS); }
}

document.getElementById('refreshBtn').addEventListener('click', load);
document.getElementById('daysSel').addEventListener('change', load);
document.getElementById('autoRefresh').addEventListener('change', setupAutoRefresh);
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPassword').addEventListener('keydown', function(e){ if(e.key==='Enter') doLogin(); });
document.getElementById('loginAccount').addEventListener('keydown', function(e){ if(e.key==='Enter') document.getElementById('loginPassword').focus(); });
document.getElementById('logoutBtn').addEventListener('click', function(){ clearSession(); showLogin(); });

// 启动：有会话直接加载，否则进入登录页；登录后开启自动刷新
loadSession();
if(session){ load(); setupAutoRefresh(); } else { showLogin(); }
</script>
</body>
</html>`;
}

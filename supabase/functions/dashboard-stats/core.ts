/**
 * dashboard-stats Edge Function core logic (no Deno dependency, unit-testable)
 *
 * 数据看板聚合逻辑：
 * - 使用 service_role 身份经 PostgREST /storage/v1 REST 直查（绕过 RLS）
 * - 三类统计：任务（task_submissions）、用量（generation_usage）、
 *   用户与组织（user_profiles/staff_directory/departments）、
 *   文件与存储（file_paths/response_file_paths + huabu bucket 对象）
 * - 自包含 HTML 看板页面生成（内联 CSS/JS，无外部依赖；自带 oa账号+密码登录，
 *   数据接口仅接受管理员用户 JWT）
 *
 * 鉴权（2026-09-16 起强制）：页面/overview/push-report 三个端点均要求
 * 「有效用户 JWT + 数据库统一 RPC is_admin()=true」（见 verifyDashboardAdmin），
 * 非管理员 403、未登录/无效 token 401；页面 JS 用登录会话的 access_token 调接口。
 */

/** 看板函数需要的环境注入（由 index.ts 从 Deno.env 读取传入） */
export interface DashboardEnv {
  SUPABASE_URL: string;
  SERVICE_ROLE_KEY: string;
  /** 页面 JS 走 GoTrue 登录与 Kong 放行所需的公钥；缺失时函数拒绝启动（不再硬编码兜底） */
  ANON_KEY: string;
}

/** 可注入依赖（便于 node:test 单测） */
export interface DashboardDeps {
  fetch?: typeof fetch;
}

/** GoTrue admin users 响应（/auth/v1/admin/users） */
interface AuthUsersResponse {
  users?: Array<{
    id?: unknown;
    user_metadata?: { displayName?: unknown; full_name?: unknown; name?: unknown };
  }>;
  next_page?: unknown;
}

/** tu-zi（new-api 底座）公开价目响应（/api/pricing） */
interface PricingResponse {
  data?: Array<{
    model_name?: unknown;
    quota_type?: unknown;
    model_ratio?: unknown;
    model_price?: unknown;
    hot_call_count?: unknown;
    hot_quota?: unknown;
  }>;
}

interface TaskRow {
  user_id?: string;
  type: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  file_paths?: unknown;
  response_file_paths?: unknown;
  model?: string;
  /** 生图张数瘦列（PostgREST JSON 提取）：params.params.n / params.n / params.count，缺省按 1 张/任务 */
  n_deep?: unknown;
  n_flat?: unknown;
  n_count?: unknown;
}

interface UsageRow {
  user_id: string;
  period: string;
  used_count: number;
}

interface ProfileRow {
  user_id: string;
  department: string | null;
  region: string | null;
  oa_account: string | null;
  created_at: string;
}

interface DepartmentRow {
  name: string;
  enabled: boolean;
}

interface StaffRow {
  oa_account: string;
  name: string;
}

/** 画布共享令牌的真实消耗（New API 网关消耗日志求和） */
export interface CanvasUsage {
  totalUsd: number;
  /** 按网关用户名（=OA 账号）汇总的 quota 原始值 */
  quotaByUsername: Record<string, number>;
  /** 窗口内 token 消耗求和（prompt+completion）；日志不含 token 字段时为 null */
  tokens: number | null;
}

/** 读取 configs 表配置值；读不到返回 null */
async function readDashboardConfig(
  env: DashboardEnv,
  configKey: string,
  deps: DashboardDeps
): Promise<string | null> {
  const doFetch = deps.fetch || fetch;
  const response = await doFetch(
    `${baseUrl(env)}/rest/v1/configs?key=eq.${encodeURIComponent(configKey)}&select=value`,
    { method: 'GET', headers: srkHeaders(env) }
  );
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as Array<{ value?: unknown }>;
  const value = Array.isArray(body) ? body[0]?.value : undefined;
  return typeof value === 'string' && value ? value : null;
}

/**
 * 画布共享令牌的真实消耗：从自建 New API 网关（configs 表 NEWAPI_URL/NEWAPI_TOKEN）
 * 的消耗日志（type=2）按令牌分页求和，USD = quota ÷ NEWAPI_QUOTA_PER_UNIT。
 * 任一步失败返回 null（调用方回退 tu-zi 价目估算）。
 */
export async function fetchCanvasUsage(
  env: DashboardEnv,
  deps: DashboardDeps = {},
  startSec = Math.floor((Date.now() - 30 * 86400000) / 1000),
  endSec = Math.floor(Date.now() / 1000)
): Promise<CanvasUsage | null> {
  const doFetch = deps.fetch || fetch;
  try {
    const base = ((await readDashboardConfig(env, 'NEWAPI_URL', deps)) || '').replace(/\/+$/, '');
    const adminToken = await readDashboardConfig(env, 'NEWAPI_TOKEN', deps);
    const apiKey = await readDashboardConfig(env, 'NEWAPI_KEY', deps);
    if (!base || !adminToken || !apiKey) {
      return null;
    }
    const headers = { Authorization: `Bearer ${adminToken}` };

    // 1. 解析画布共享令牌名：NEWAPI_KEY 去 sk- 前缀后与令牌 key 匹配
    const keySuffix = apiKey.replace(/^sk-/, '');
    let tokenName = '';
    const tokenRes = await doFetch(`${base}/api/token/?p=1&size=100`, { headers });
    if (tokenRes.ok) {
      const tokenBody = (await tokenRes.json()) as {
        data?: { items?: Array<{ name?: unknown; key?: unknown }> } | Array<{ name?: unknown; key?: unknown }>;
      };
      const items = Array.isArray(tokenBody?.data)
        ? tokenBody.data
        : Array.isArray(tokenBody?.data?.items)
          ? tokenBody.data.items
          : [];
      const match = items.find(
        (t) =>
          (typeof t.key === 'string' && (t.key === keySuffix || `sk-${t.key}` === apiKey)) ||
          t.key === keySuffix
      );
      if (match && typeof match.name === 'string') {
        tokenName = match.name;
      }
    }
    if (!tokenName) {
      tokenName = 'huabu'; // 历史约定名，匹配失败时兜底
    }

    // 2. 分页求和窗口内 type=2 消耗日志（网关把 page_size 静默限制在 100）
    const PAGE_SIZE = 100;
    let sum = 0;
    let tokenSum = 0;
    let tokenSeen = false;
    const quotaByUsername: Record<string, number> = {};
    for (let page = 1; page <= 60; page += 1) {
      const res = await doFetch(
        `${base}/api/log/?p=${page}&page_size=${PAGE_SIZE}&type=2&token_name=${encodeURIComponent(tokenName)}&start_timestamp=${startSec}&end_timestamp=${endSec}`,
        { headers }
      );
      if (!res.ok) {
        return null;
      }
      const body = (await res.json()) as {
        data?: { items?: Array<{ quota?: unknown; username?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown }> };
      };
      const items = Array.isArray(body?.data?.items) ? body.data.items : [];
      for (const item of items) {
        const quota = Number(item?.quota ?? 0);
        if (!Number.isFinite(quota)) {
          continue;
        }
        sum += quota;
        const username = typeof item?.username === 'string' ? item.username : '';
        if (username) {
          quotaByUsername[username] = (quotaByUsername[username] ?? 0) + quota;
        }
        // token 字段存在才累计：绘图按次计费的日志可能没有 token 字段
        const hasP = item?.prompt_tokens != null;
        const hasC = item?.completion_tokens != null;
        if (hasP || hasC) {
          const p = Number(item?.prompt_tokens ?? 0);
          const c = Number(item?.completion_tokens ?? 0);
          if (Number.isFinite(p) && Number.isFinite(c)) {
            tokenSeen = true;
            tokenSum += p + c;
          }
        }
      }
      if (items.length < PAGE_SIZE) {
        break;
      }
    }
    return { totalUsd: sum / NEWAPI_QUOTA_PER_UNIT, quotaByUsername, tokens: tokenSeen ? tokenSum : null };
  } catch {
    return null;
  }
}

/** 钉钉机器人与 Gitee 图片中转的 configs 键 */
export const DING_WEBHOOK_CONFIG_KEY = 'DINGTALK_WEBHOOK';
export const DING_SECRET_CONFIG_KEY = 'DINGTALK_SECRET';
/** 推送测试目标（开发群）：DEV 开头的钉钉 webhook 配置 */
export const DEV_DING_WEBHOOK_CONFIG_KEY = 'DEV_DINGTALK_WEBHOOK';
export const DEV_DING_SECRET_CONFIG_KEY = 'DEV_DINGTALK_SECRET';
export const GITEE_TOKEN_CONFIG_KEY = 'GITEE_TOKEN';
export const GITEE_REPO_CONFIG_KEY = 'GITEE_REPO';
export const DEFAULT_GITEE_REPO = 'tju-kdj_admin/dingding-talk-images';
/** 领导视角「节省委外费用」估算用的单张效果图委外参考价（CNY/张）configs 键 */
export const OUTSOURCE_PRICE_CONFIG_KEY = 'OUTSOURCE_PRICE_PER_IMAGE';

export interface DingPushResult {
  ok: boolean;
  imageUrl?: string;
  error?: string;
}

/** 钉钉加签：HmacSHA256(`${timestamp}\n${secret}`) 的 base64 */
export async function dingSign(secret: string, timestamp: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}\n${secret}`));
  let bin = '';
  for (const b of new Uint8Array(sig)) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

/** 上传 PNG（base64，可含 dataURL 前缀）到 Gitee 仓库，返回可公开访问的图片 URL */
export async function uploadGiteeImage(
  env: DashboardEnv,
  deps: DashboardDeps,
  imageBase64: string,
  filename: string
): Promise<string | null> {
  const doFetch = deps.fetch || fetch;
  try {
    const token = await readDashboardConfig(env, GITEE_TOKEN_CONFIG_KEY, deps);
    if (!token) {
      return null;
    }
    const repo =
      (await readDashboardConfig(env, GITEE_REPO_CONFIG_KEY, deps)) ||
      DEFAULT_GITEE_REPO;
    const base64 = imageBase64.includes(',')
      ? imageBase64.slice(imageBase64.indexOf(',') + 1)
      : imageBase64;
    const apiPath = `dashboard-stats/${filename}`;
    const branchRes = await doFetch(
      `https://gitee.com/api/v5/repos/${repo}?access_token=${encodeURIComponent(token)}`,
      { method: 'GET' }
    );
    let branch = 'master';
    if (branchRes.ok) {
      const info = (await branchRes.json()) as { default_branch?: unknown };
      if (typeof info?.default_branch === 'string' && info.default_branch) {
        branch = info.default_branch;
      }
    }
    const res = await doFetch(
      `https://gitee.com/api/v5/repos/${repo}/contents/${apiPath}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: token,
          branch,
          content: base64,
          message: `dashboard export ${filename}`,
        }),
      }
    );
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as {
      content?: { download_url?: unknown };
    };
    const url =
      typeof body?.content?.download_url === 'string'
        ? body.content.download_url
        : `https://gitee.com/${repo}/raw/${branch}/${apiPath}`;
    return url;
  } catch {
    return null;
  }
}

/** 发送钉钉 markdown 消息（加签），返回是否成功 */
export async function sendDingTalkMarkdown(
  env: DashboardEnv,
  deps: DashboardDeps,
  text: string,
  imageUrl?: string,
  opts: {
    webhookKey?: string;
    secretKey?: string;
    /** 强制要求加签 secret（推送测试用；缺失视为配置错误） */
    requireSecret?: boolean;
    title?: string;
  } = {}
): Promise<{ ok: boolean; error?: string }> {
  const doFetch = deps.fetch || fetch;
  try {
    const webhookKey = opts.webhookKey ?? DING_WEBHOOK_CONFIG_KEY;
    const secretKey = opts.secretKey ?? DING_SECRET_CONFIG_KEY;
    const webhook = await readDashboardConfig(env, webhookKey, deps);
    const secret = await readDashboardConfig(env, secretKey, deps);
    if (!webhook) {
      return { ok: false, error: `configs 缺少 ${webhookKey} 配置` };
    }
    if (opts.requireSecret && !secret) {
      return { ok: false, error: `configs 缺少 ${secretKey} 配置（推送测试要求强制加签）` };
    }
    let url = webhook;
    if (secret) {
      const ts = Date.now();
      const sign = await dingSign(secret, ts);
      url += (webhook.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
    }
    const content = imageUrl ? `${text}\n\n![dashboard](${imageUrl})` : text;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: opts.title ?? 'YUE 画布使用周报', text: content },
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `钉钉接口 HTTP ${res.status}` };
    }
    const body = (await res.json()) as { errcode?: unknown; errmsg?: unknown };
    if (Number(body?.errcode ?? -1) !== 0) {
      return { ok: false, error: `钉钉返回错误: ${String(body?.errmsg ?? 'unknown')}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** 推送周报：图片上传 Gitee 中转 → 钉钉机器人发送 markdown（文字 + 图片）；
 *  opts.dev=true 时改推 DEV_DINGTALK_WEBHOOK（强制 DEV_DINGTALK_SECRET 加签，
 *  标题带「推送测试」标识），走完整周报链路供开发群验证。 */
export async function pushReport(
  env: DashboardEnv,
  deps: DashboardDeps,
  imageBase64: string,
  text: string,
  opts: { dev?: boolean } = {}
): Promise<DingPushResult> {
  let imageUrl: string | undefined;
  if (imageBase64) {
    const ts = new Date();
    const p = (x: number) => String(x).padStart(2, '0');
    const filename = `dashboard-${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}-${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}.png`;
    imageUrl = (await uploadGiteeImage(env, deps, imageBase64, filename)) || undefined;
    if (!imageUrl) {
      return { ok: false, error: '图片上传 Gitee 失败（检查 GITEE_TOKEN/GITEE_REPO 配置）' };
    }
  }
  if (!text) {
    return { ok: false, error: '报告内容为空' };
  }
  const sent = await sendDingTalkMarkdown(
    env,
    deps,
    text,
    imageUrl,
    opts.dev
      ? {
          webhookKey: DEV_DING_WEBHOOK_CONFIG_KEY,
          secretKey: DEV_DING_SECRET_CONFIG_KEY,
          requireSecret: true,
          title: 'YUE 画布使用周报（推送测试）',
        }
      : {}
  );
  return sent.ok ? { ok: true, imageUrl } : sent;
}

/** 统计成功任务次数（Content-Range 计数，可按时段/类型过滤，失败返回 0） */
async function countCompleted(
  env: DashboardEnv,
  deps: DashboardDeps,
  opts: { fromIso?: string; toIso?: string; type?: string } = {}
): Promise<number> {
  const doFetch = deps.fetch || fetch;
  try {
    const parts = ['select=id', 'status=eq.completed'];
    if (opts.type) {
      parts.push(`type=eq.${encodeURIComponent(opts.type)}`);
    }
    if (opts.fromIso) {
      parts.push(`created_at=gte.${encodeURIComponent(opts.fromIso)}`);
    }
    if (opts.toIso) {
      parts.push(`created_at=lt.${encodeURIComponent(opts.toIso)}`);
    }
    parts.push('limit=1');
    const response = await doFetch(
      `${baseUrl(env)}/rest/v1/task_submissions?${parts.join('&')}`,
      { method: 'GET', headers: { ...srkHeaders(env), Prefer: 'count=exact' } }
    );
    if (!response.ok) {
      // 静默返回 0 会让周报口径失真，至少留下告警日志
      console.error('[dashboard-stats] countCompleted failed:', response.status);
      return 0;
    }
    const match = /^\d+-\d+\/(\d+)$/.exec(
      (response.headers.get('content-range') || '').trim()
    );
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/** 聚合的最终返回结构 */
export interface DashboardOverview {
  generatedAt: string;
  days: number;
  /** 美元→人民币展示汇率（configs 表 USD_CNY_RATE，缺省 0.1） */
  usdCnyRate: number;
  /** 最近一周（上一个完整的周一~周日，东八区）成功任务次数 */
  weekTasks: number;
  /** 近 30 天消耗金额（USD，网关日志求和；不可用为 null） */
  monthCostUsd: number | null;
  tasks: {
    /** 口径：仅统计成功（status=completed）任务 */
    total: number;
    byType: Record<string, number>;
    /** 模型使用分布（params->>model） */
    byModel: Record<string, number>;
    /** 活跃用户数（窗口内成功任务的去重用户数） */
    activeUsers: number;
    avgDurationMs: number;
    dailyTrend: Array<{ date: string; count: number }>;
    /** 24 小时使用分布（东八区，下标 0-23） */
    hourly: number[];
    /** 使用次数排行（按用户，前 10） */
    topUsers: Array<{
      userId: string;
      displayName: string | null;
      department: string | null;
      count: number;
    }>;
    /** 全量用户使用排行（窗口内成功任务次数，按次数降序；页面「用户使用排行」用） */
    userUsage: Array<{
      userId: string;
      displayName: string | null;
      department: string | null;
      count: number;
    }>;
    /** 消耗金额（USD，按 tu-zi 价目折算；价目不可用时为 null） */
    totalCostUsd: number | null;
  };
  usage: {
    quotaLimit: number;
    byPeriod: Array<{ period: string; used: number }>;
    latestPeriod: string;
    latestUsed: number;
    topUsers: Array<{
      oaAccount: string | null;
      /** Display Name：auth.users.user_metadata.displayName 优先，其次 staff_directory.name，均无为 null（页面回退 oaAccount） */
      displayName: string | null;
      department: string | null;
      used: number;
    }>;
  };
  users: {
    total: number;
    byDepartment: Record<string, number>;
    byRegion: Record<string, number>;
    /** 部门使用情况（窗口内成功任务次数按用户部门汇总） */
    usageByDepartment: Record<string, number>;
    /** 使用排行（窗口内成功任务次数按用户区域汇总，页面「部门使用排行」用） */
    usageByRegion: Record<string, number>;
    /** 部门消耗金额（USD，按 tu-zi 价目估算；价目不可用时为空对象） */
    costByDepartment: Record<string, number>;
    staffDirectory: number;
    enabledDepartments: number;
  };
  /** 领导视角核心指标（对照课题汇报口径：调用/产出/消耗/降本） */
  leadership: LeadershipBlock;
}

/** 领导视角核心指标（口径对应《AI为翼，雏鹰启航》课题汇报中的数据清单） */
export interface LeadershipBlock {
  /** 窗口内生成图片张数（按任务参数 n/count 汇总，缺省 1 张/任务） */
  windowImages: number;
  /** 窗口内生图任务次数 */
  windowImageTasks: number;
  /** 窗口内生图任务平均耗时（毫秒；无样本为 0） */
  avgImageDurationMs: number;
  /** 窗口内最常用模型（按成功任务计） */
  topModel: string | null;
  topModelCount: number;
  /** 窗口内使用的模型类型数 */
  modelTypes: number;
  /** 窗口内 token 消耗（网关日志求和；日志无 token 字段/网关不可用为 null） */
  tokens: number | null;
  /** 全时段累计成功调用次数（查询失败为 null） */
  allTimeCalls: number | null;
  /** 全时段累计生图任务次数（查询失败为 null） */
  allTimeImageTasks: number | null;
  /** 单张效果图委外参考价（CNY，configs 表 OUTSOURCE_PRICE_PER_IMAGE；未配置为 null） */
  outsourcePriceCny: number | null;
  /** 窗口内等效委外成本（CNY = 张数 × 单价；未配置单价或无产出为 null） */
  outsourceEquivalentCny: number | null;
  /** 窗口内节省委外费用（CNY = 等效委外成本 − 实际消耗折算；不可算为 null，负值如实展示） */
  savedCny: number | null;
}

// ============================================================================
// 基础 REST 工具（service_role 身份，绕过 RLS）
// ============================================================================

function baseUrl(env: DashboardEnv): string {
  return (env.SUPABASE_URL || '').replace(/\/+$/, '');
}

function srkHeaders(
  env: DashboardEnv,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    apikey: env.SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`,
    Accept: 'application/json',
    ...extra,
  };
}

async function restGet(
  env: DashboardEnv,
  path: string,
  deps: DashboardDeps
): Promise<{ rows: unknown[]; total: number | null }> {
  const doFetch = deps.fetch || fetch;
  const response = await doFetch(`${baseUrl(env)}${path}`, {
    method: 'GET',
    headers: srkHeaders(env),
  });
  if (!response.ok) {
    throw new Error(
      `rest query failed ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`
    );
  }
  const body = (await response.json()) as unknown;
  const rows = Array.isArray(body) ? body : [];
  // PostgREST 的 Prefer: count=exact 会把总数放在 Content-Range: 0-0/123 里
  const total = parseContentRangeTotal(response.headers.get('content-range'));
  return { rows, total };
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) {
    return null;
  }
  const match = /^\d+-\d+\/(\d+)$/.exec(header.trim());
  return match ? Number(match[1]) : null;
}

function countOccurrences(rows: Array<{ [k: string]: unknown }>, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? 'unknown');
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Display Name 解析：认证表 displayName 优先，其次花名册姓名，均无返回 null */
function resolveDisplayName(
  userId: string | null,
  oaAccount: string | null,
  nameByUser: Map<string, string>,
  nameByOa: Map<string, string>
): string | null {
  return (
    (userId && nameByUser.get(userId)) ||
    (oaAccount && nameByOa.get(oaAccount)) ||
    null
  );
}

/**
 * 把真实消耗总额按各部门估算金额的占比分摊，使求和恰好等于总额
 * （估算价与真实计费口径不同，但占比反映各部门真实用量结构）；
 * 四舍五入产生的余数计入最大部门。无法分摊（无估算/总额无效）返回原值。
 */
export function scaleCostByDepartment(
  costs: Record<string, number>,
  targetTotal: number | null
): Record<string, number> {
  const entries = Object.entries(costs);
  const estimateTotal = entries.reduce((s, e) => s + e[1], 0);
  if (
    targetTotal == null ||
    !Number.isFinite(targetTotal) ||
    estimateTotal <= 0 ||
    !Number.isFinite(estimateTotal)
  ) {
    return { ...costs };
  }
  const scaled = entries.map(
    ([dept, cost]) => [dept, (cost / estimateTotal) * targetTotal] as [string, number]
  );
  scaled.sort((a, b) => b[1] - a[1]);
  const scaledSum = scaled.reduce((s, e) => s + e[1], 0);
  const residual = Math.round((targetTotal - scaledSum) * 100) / 100;
  if (scaled.length > 0 && residual !== 0) {
    scaled[0][1] = Math.round((scaled[0][1] + residual) * 100) / 100;
  }
  const out: Record<string, number> = {};
  for (const [dept, cost] of scaled) {
    out[dept] = Math.round(cost * 100) / 100;
  }
  return out;
}

function clampDays(days: unknown): number {
  const n = typeof days === 'string' ? Number(days) : Number(days) || 30;
  if (!Number.isFinite(n)) {
    return 30;
  }
  return Math.min(Math.max(Math.round(n), 1), 365);
}

function dateNDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// 各统计块
// ============================================================================

/** 业务统计时区：用户群在国内，按东八区切日/切小时 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 东八区本地日期（YYYY-MM-DD）与小时（0-23） */
function localDateAndHour(iso: string): { date: string; hour: number } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return null;
  }
  const shifted = new Date(t + TZ_OFFSET_MS).toISOString();
  return { date: shifted.slice(0, 10), hour: Number(shifted.slice(11, 13)) };
}

/** 模型使用分布（成功任务 params->>model 计数） */
function countModelUsage(rows: TaskRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const model = (row.model || '').trim();
    if (model) {
      out[model] = (out[model] ?? 0) + 1;
    }
  }
  return out;
}

/** 任务统计：task_submissions（仅统计成功 completed 任务） */
export function aggregateTasks(rows: TaskRow[]): DashboardOverview['tasks'] {
  const okRows = rows.filter((row) => row.status === 'completed');
  const byType = countOccurrences(okRows, 'type');
  const byModel = countModelUsage(okRows);
  const activeUsers = new Set(
    okRows.map((row) => row.user_id).filter((id): id is string => Boolean(id))
  ).size;

  const trendMap = new Map<string, number>();
  const hourly = new Array<number>(24).fill(0);
  let durationSum = 0;
  let durationCount = 0;
  for (const row of okRows) {
    const local = row.created_at ? localDateAndHour(row.created_at) : null;
    if (local) {
      trendMap.set(local.date, (trendMap.get(local.date) ?? 0) + 1);
      hourly[local.hour] += 1;
    }
    if (
      typeof row.created_at === 'string' &&
      typeof row.completed_at === 'string'
    ) {
      durationSum +=
        new Date(row.completed_at).getTime() - new Date(row.created_at).getTime();
      durationCount += 1;
    }
  }

  return {
    total: okRows.length,
    byType,
    byModel,
    activeUsers,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    dailyTrend: Array.from(trendMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    hourly,
    topUsers: [],
  };
}

/**
 * 单任务生图张数：优先任务参数 n（嵌套 params.params.n / 顶层 params.n）与 count，
 * 均缺省按 1 张/任务（历史任务或参数缺失时保底）。
 */
export function taskImageCount(
  row: Pick<TaskRow, 'n_deep' | 'n_flat' | 'n_count'>
): number {
  for (const value of [row.n_deep, row.n_flat, row.n_count]) {
    const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    if (Number.isFinite(n) && n > 0) {
      return Math.round(n);
    }
  }
  return 1;
}

/**
 * 解析单张效果图委外参考价（CNY）：非数字/非正数一律回退 null（看板显示 - 并提示配置）。
 */
export function parseOutsourcePrice(raw: unknown): number | null {
  const parsed = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** aggregateLeadership 的外部数据入参 */
export interface LeadershipOptions {
  /** 窗口内网关日志 token 求和（不可用 null） */
  tokens: number | null;
  /** 全时段累计成功调用次数（查询失败 null） */
  allTimeCalls: number | null;
  /** 全时段累计生图任务次数（查询失败 null） */
  allTimeImageTasks: number | null;
  /** 单张效果图委外参考价（CNY，未配置 null） */
  outsourcePriceCny: number | null;
  /** 窗口内实际消耗（USD，与 tasks.totalCostUsd 同口径） */
  actualCostUsd: number | null;
  /** 美元→人民币展示汇率 */
  usdCnyRate: number;
}

/**
 * 领导视角核心指标（对照课题汇报数据清单）：
 * 产出（生成图片张数/次数、平均出图耗时）、消耗（token、模型种类/最常用模型）、
 * 累计（全时段调用/生图次数）、降本（委外单价 × 张数 − 实际消耗的节约估算）。
 */
export function aggregateLeadership(
  rows: TaskRow[],
  opts: LeadershipOptions
): LeadershipBlock {
  const okRows = rows.filter((row) => row.status === 'completed');
  const imageRows = okRows.filter((row) => row.type === 'image');
  const windowImages = imageRows.reduce((sum, row) => sum + taskImageCount(row), 0);

  let durationSum = 0;
  let durationCount = 0;
  for (const row of imageRows) {
    if (
      typeof row.created_at === 'string' &&
      typeof row.completed_at === 'string'
    ) {
      durationSum +=
        new Date(row.completed_at).getTime() - new Date(row.created_at).getTime();
      durationCount += 1;
    }
  }

  const modelEntries = Object.entries(countModelUsage(okRows)).sort(
    (a, b) => b[1] - a[1]
  );

  const price = opts.outsourcePriceCny;
  const outsourceEquivalentCny =
    price != null && windowImages > 0
      ? Math.round(windowImages * price * 100) / 100
      : null;
  const savedCny =
    outsourceEquivalentCny != null && opts.actualCostUsd != null
      ? Math.round(
          (outsourceEquivalentCny - opts.actualCostUsd * opts.usdCnyRate) * 100
        ) / 100
      : null;

  return {
    windowImages,
    windowImageTasks: imageRows.length,
    avgImageDurationMs:
      durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    topModel: modelEntries.length > 0 ? modelEntries[0][0] : null,
    topModelCount: modelEntries.length > 0 ? modelEntries[0][1] : 0,
    modelTypes: modelEntries.length,
    tokens: opts.tokens,
    allTimeCalls: opts.allTimeCalls,
    allTimeImageTasks: opts.allTimeImageTasks,
    outsourcePriceCny: price,
    outsourceEquivalentCny,
    savedCny,
  };
}

/** 部门在看板上的展示名映射（仅展示层；底层数据保持原部门名） */
const DEPARTMENT_DISPLAY_NAMES: Record<string, string> = {
  人力资源部: '职能部门',
};

export function displayDepartmentName(department: string): string {
  return DEPARTMENT_DISPLAY_NAMES[department] ?? department;
}

/** 任务参与统计结果（独立命名类型：node 类型剥离不支持多行交集返回注解，见 core.test.ts 同款约定） */
export interface TaskParticipationResult
  extends Pick<DashboardOverview['tasks'], 'topUsers' | 'userUsage'> {
  usageByDepartment: Record<string, number>;
  usageByRegion: Record<string, number>;
  costByDepartment: Record<string, number>;
}

/** 任务参与统计：使用次数排行（按用户前 10）、全量用户排行、部门/区域使用情况与部门消耗金额 */
export function aggregateTaskParticipation(
  rows: TaskRow[],
  profileRows: ProfileRow[],
  nameByOa: Map<string, string>,
  nameByUser: Map<string, string>,
  priceByModel: Map<string, number> = new Map()
): TaskParticipationResult {
  const okRows = rows.filter((row) => row.status === 'completed');
  const deptByUser = new Map(
    profileRows.map((p) => [p.user_id, displayDepartmentName(p.department)])
  );
  const regionByUser = new Map(profileRows.map((p) => [p.user_id, p.region]));
  const oaByUser = new Map(profileRows.map((p) => [p.user_id, p.oa_account]));

  const countByUser = new Map<string, number>();
  const usageByDepartment: Record<string, number> = {};
  const usageByRegion: Record<string, number> = {};
  const costByDepartment: Record<string, number> = {};
  // 区域排行需展示全部分组：先为所有有用户的区域建立 0 计数
  for (const p of profileRows) {
    const region = p.region || '未知区域';
    if (!(region in usageByRegion)) {
      usageByRegion[region] = 0;
    }
  }
  for (const row of okRows) {
    const userId = row.user_id || '';
    if (!userId) {
      continue;
    }
    countByUser.set(userId, (countByUser.get(userId) ?? 0) + 1);
    const dept = deptByUser.get(userId) || '未知部门';
    usageByDepartment[dept] = (usageByDepartment[dept] ?? 0) + 1;
    const region = regionByUser.get(userId) || '未知区域';
    usageByRegion[region] = (usageByRegion[region] ?? 0) + 1;
    const price = row.model ? priceByModel.get(row.model) : undefined;
    if (price !== undefined) {
      costByDepartment[dept] =
        (costByDepartment[dept] ?? 0) + price;
    }
  }

  // 全量用户排行（降序）；topUsers 仍为前 10 截断（周报口径不变）
  const userUsage = Array.from(countByUser.entries())
    .map(([userId, count]) => {
      const oaAccount = oaByUser.get(userId) ?? null;
      return {
        userId,
        displayName: resolveDisplayName(userId, oaAccount, nameByUser, nameByOa),
        department: deptByUser.get(userId) ?? null,
        count,
      };
    })
    .sort((a, b) => b.count - a.count);

  const topUsers = userUsage.slice(0, 10);

  return { topUsers, userUsage, usageByDepartment, usageByRegion, costByDepartment };
}

/** 用量与额度：generation_usage + user_profiles join + 部门配置限额 */
export function aggregateUsage(
  usageRows: UsageRow[],
  profileRows: ProfileRow[],
  quotaLimit: number,
  nameByOa: Map<string, string> = new Map(),
  nameByUser: Map<string, string> = new Map()
): DashboardOverview['usage'] {
  const byPeriodMap = new Map<string, number>();
  for (const row of usageRows) {
    const period = row.period || 'unknown';
    byPeriodMap.set(period, (byPeriodMap.get(period) ?? 0) + Number(row.used_count || 0));
  }
  const byPeriod = Array.from(byPeriodMap.entries())
    .map(([period, used]) => ({ period, used }))
    .sort((a, b) => a.period.localeCompare(b.period));

  const latestPeriod = byPeriod.length > 0 ? byPeriod[byPeriod.length - 1].period : '';
  const latestUsed = byPeriod.length > 0 ? byPeriod[byPeriod.length - 1].used : 0;

  const profileByUserId = new Map<string, ProfileRow>();
  for (const profile of profileRows) {
    profileByUserId.set(profile.user_id, profile);
  }
  const usageByUser = new Map<string, number>();
  for (const row of usageRows) {
    if (row.period !== latestPeriod) {
      continue;
    }
    usageByUser.set(row.user_id, (usageByUser.get(row.user_id) ?? 0) + Number(row.used_count || 0));
  }
  const topUsers = Array.from(usageByUser.entries())
    .map(([userId, used]) => {
      const profile = profileByUserId.get(userId);
      const oaAccount = profile?.oa_account ?? null;
      return {
        oaAccount,
        displayName: resolveDisplayName(userId, oaAccount, nameByUser, nameByOa),
        department: profile?.department ?? null,
        used,
      };
    })
    .sort((a, b) => b.used - a.used)
    .slice(0, 10);

  return { quotaLimit, byPeriod, latestPeriod, latestUsed, topUsers };
}

/** 用户与组织：user_profiles + staff_directory + departments */
export function aggregateUsers(
  profileRows: ProfileRow[],
  staffDirectoryTotal: number,
  departmentRows: DepartmentRow[]
): DashboardOverview['users'] {
  return {
    total: profileRows.length,
    byDepartment: Object.fromEntries(
      Object.entries(countOccurrences(profileRows, 'department')).map(
        ([dept, count]) => [displayDepartmentName(dept), count]
      )
    ),
    byRegion: countOccurrences(profileRows, 'region'),
    staffDirectory: staffDirectoryTotal,
    enabledDepartments: departmentRows.filter((d) => d.enabled).length,
  };
}

/**
 * tu-zi（new-api 底座）按模型单次调用价目（USD）。
 * 口径（按优先级）：
 * 1. 平台实测均值 hot_quota ÷ hot_call_count ÷ 500000——绘图模型按 token 计费且
 *    图片输出有额外倍率（image_output_ratio），固定 token 假设会严重低估，实测
 *    均值最接近真实单价（样本量足够时采用，≥100 次）；
 * 2. quota_type=0 按次计费：model_price；
 * 3. quota_type=1 按量计费：model_ratio × ESTIMATED_OUTPUT_TOKENS_PER_CALL ÷
 *    NEWAPI_QUOTA_PER_UNIT（new-api 默认 $1 = 500000 quota）。
 * 价目不可用时返回空映射（页面金额降级显示 -）。
 */
export const TUZI_PRICING_URL = 'https://api.tu-zi.com/api/pricing';
export const ESTIMATED_OUTPUT_TOKENS_PER_CALL = 1500;
export const NEWAPI_QUOTA_PER_UNIT = 500000;
/** 美元→人民币展示汇率缺省值（configs 表 USD_CNY_RATE 可覆盖） */
export const DEFAULT_USD_CNY_RATE = 0.1;
/** 用量倍数缺省值（configs 表 USAGE_MULTIPLIER 可覆盖；所有使用次数与金额按倍数放大） */
export const DEFAULT_USAGE_MULTIPLIER = 1;

/**
 * 解析用量倍数：非数字/非正数一律回退缺省值 1。
 */
export function parseUsageMultiplier(raw: unknown): number {
  const parsed =
    typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * 在聚合出口处统一按倍数缩放看板数据：
 * - 缩放：所有使用次数（total/weekTasks/byType/byModel/dailyTrend/hourly/
 *   topUsers.count/latestUsed/byPeriod.used/usageByDepartment/usageByRegion）
 *   与金额（totalCostUsd/monthCostUsd/costByDepartment）
 * - 不变：活跃用户数、用户数分布、数据覆盖天数、额度上限、汇率
 */
export function applyUsageMultiplier(
  overview: DashboardOverview,
  multiplier: number
): DashboardOverview {
  const scaleCounts = (record: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        Math.round(value * multiplier),
      ])
    );
  // 金额保留两位小数（次数取整无妨，金额四舍五入会丢失零头）
  const scaleMoney = (record: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        Math.round(value * multiplier * 100) / 100,
      ])
    );

  return {
    ...overview,
    weekTasks: Math.round(overview.weekTasks * multiplier),
    monthCostUsd:
      overview.monthCostUsd == null
        ? null
        : Math.round(overview.monthCostUsd * multiplier * 100) / 100,
    tasks: {
      ...overview.tasks,
      total: Math.round(overview.tasks.total * multiplier),
      byType: scaleCounts(overview.tasks.byType),
      byModel: scaleCounts(overview.tasks.byModel),
      dailyTrend: overview.tasks.dailyTrend.map((item) => ({
        ...item,
        count: Math.round(item.count * multiplier),
      })),
      hourly: overview.tasks.hourly.map((count) =>
        Math.round(count * multiplier)
      ),
      topUsers: overview.tasks.topUsers.map((user) => ({
        ...user,
        count: Math.round(user.count * multiplier),
      })),
      userUsage: overview.tasks.userUsage.map((user) => ({
        ...user,
        count: Math.round(user.count * multiplier),
      })),
      totalCostUsd:
        overview.tasks.totalCostUsd == null
          ? null
          : Math.round(overview.tasks.totalCostUsd * multiplier * 100) / 100,
    },
    usage: {
      ...overview.usage,
      byPeriod: overview.usage.byPeriod.map((item) => ({
        ...item,
        used: Math.round(item.used * multiplier),
      })),
      latestUsed: Math.round(overview.usage.latestUsed * multiplier),
      topUsers: overview.usage.topUsers.map((user) => ({
        ...user,
        used: Math.round(user.used * multiplier),
      })),
    },
    users: {
      ...overview.users,
      usageByDepartment: scaleCounts(overview.users.usageByDepartment),
      usageByRegion: scaleCounts(overview.users.usageByRegion),
      costByDepartment: scaleMoney(overview.users.costByDepartment),
    },
    leadership: {
      ...overview.leadership,
      windowImages: Math.round(overview.leadership.windowImages * multiplier),
      windowImageTasks: Math.round(
        overview.leadership.windowImageTasks * multiplier
      ),
      tokens:
        overview.leadership.tokens == null
          ? null
          : Math.round(overview.leadership.tokens * multiplier),
      allTimeCalls:
        overview.leadership.allTimeCalls == null
          ? null
          : Math.round(overview.leadership.allTimeCalls * multiplier),
      allTimeImageTasks:
        overview.leadership.allTimeImageTasks == null
          ? null
          : Math.round(overview.leadership.allTimeImageTasks * multiplier),
      topModelCount: Math.round(overview.leadership.topModelCount * multiplier),
      outsourceEquivalentCny:
        overview.leadership.outsourceEquivalentCny == null
          ? null
          : Math.round(
              overview.leadership.outsourceEquivalentCny * multiplier * 100
            ) / 100,
      savedCny:
        overview.leadership.savedCny == null
          ? null
          : Math.round(overview.leadership.savedCny * multiplier * 100) / 100,
    },
  };
}

const MIN_HOT_CALLS_FOR_EMPIRICAL = 100;

export async function fetchModelPricing(
  deps: DashboardDeps = {},
  pricingUrl: string = TUZI_PRICING_URL
): Promise<Map<string, number>> {
  const doFetch = deps.fetch || fetch;
  try {
    const response = await doFetch(pricingUrl, { method: 'GET' });
    if (!response.ok) {
      return new Map();
    }
    const body = (await response.json()) as PricingResponse;
    const list = Array.isArray(body?.data) ? body.data : [];
    const prices = new Map<string, number>();
    for (const item of list) {
      const name = typeof item?.model_name === 'string' ? item.model_name : '';
      if (!name) {
        continue;
      }
      let perCall = Number.NaN;
      const hotCalls = Number(item.hot_call_count);
      const hotQuota = Number(item.hot_quota);
      if (
        Number.isFinite(hotCalls) &&
        hotCalls >= MIN_HOT_CALLS_FOR_EMPIRICAL &&
        Number.isFinite(hotQuota) &&
        hotQuota > 0
      ) {
        perCall = hotQuota / hotCalls / NEWAPI_QUOTA_PER_UNIT;
      } else if (item.quota_type === 0) {
        perCall = Number(item.model_price);
      } else if (item.quota_type === 1) {
        perCall =
          (Number(item.model_ratio) * ESTIMATED_OUTPUT_TOKENS_PER_CALL) /
          NEWAPI_QUOTA_PER_UNIT;
      }
      if (Number.isFinite(perCall) && perCall > 0) {
        prices.set(name, perCall);
      }
    }
    return prices;
  } catch {
    return new Map();
  }
}

/**
 * 认证用户 Display Name 映射（auth.users.user_metadata.displayName，按 user_id）。
 * GoTrue admin API 分页拉取；网关未放行 /auth/v1/admin 时降级尝试自托管内部
 * auth 服务（http://auth:9999），仍不可用返回空映射（调用方回退花名册/OA 账号）。
 */
export async function fetchAuthDisplayNames(
  env: DashboardEnv,
  deps: DashboardDeps = {}
): Promise<Map<string, string>> {
  const bases = [
    `${baseUrl(env)}/auth/v1/admin/users`,
    'http://auth:9999/admin/users',
  ];
  for (const base of bases) {
    try {
      const result = await fetchAuthNamesFrom(base, env, deps);
      if (result !== null) {
        return result;
      }
    } catch {
      // 端点不可用 → 尝试下一个 base
    }
  }
  return new Map();
}

/** 从单个 GoTrue admin 端点分页拉取；端点不可用返回 null（区别于可用但无数据） */
async function fetchAuthNamesFrom(
  base: string,
  env: DashboardEnv,
  deps: DashboardDeps
): Promise<Map<string, string> | null> {
  const doFetch = deps.fetch || fetch;
  const names = new Map<string, string>();
  for (let page = 1; page <= 50; page += 1) {
    const response = await doFetch(`${base}?page=${page}&per_page=200`, {
      method: 'GET',
      headers: srkHeaders(env),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as AuthUsersResponse;
    const users = Array.isArray(body?.users) ? body.users : [];
    for (const user of users) {
      const id = typeof user?.id === 'string' ? user.id : '';
      // 键名随注册时期不同：displayName（主应用）/ full_name（早期）/ name（OAuth 惯例）
      const md = user?.user_metadata ?? {};
      const raw = [md.displayName, md.full_name, md.name].find(
        (v) => typeof v === 'string' && v.trim() !== ''
      );
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (id && name) {
        names.set(id, name);
      }
    }
    if (users.length === 0) {
      return names;
    }
    const next = Number(body?.next_page);
    if (!Number.isFinite(next) || next <= page) {
      return names;
    }
    page = next - 1; // for 循环自增后到达 next 页
  }
  return names;
}

/** 读取部门配置 KV（image_monthly_quota_default）；读不到返回默认值 */
export async function readQuotaLimit(
  env: DashboardEnv,
  deps: DashboardDeps,
  fallback = 200
): Promise<number> {
  try {
    const { rows } = await restGet(
      env,
      `/rest/v1/department_configs?key=eq.image_monthly_quota_default&select=value&limit=1`,
      deps
    );
    const value = (rows[0] as { value?: unknown } | undefined)?.value;
    const n = typeof value === 'string' ? Number(value) : Number(value);
    if (Number.isFinite(n) && n > 0) {
      return Math.round(n);
    }
  } catch {
    // 配置表缺失/查询失败时用默认值
  }
  return fallback;
}

// ============================================================================
// 主聚合入口
// ============================================================================

/** 聚合全量看板数据（days 为过滤窗口天数；range 给定时按精确日期窗口过滤） */
export async function aggregateOverview(
  env: DashboardEnv,
  days: number,
  deps: DashboardDeps = {},
  range?: { start: string; end: string }
): Promise<DashboardOverview> {
  const safeDays = clampDays(days);
  // range（YYYY-MM-DD，东八区语义）优先于 days 窗口
  const useRange = Boolean(range && range.start && range.end);
  const taskFrom = useRange
    ? encodeURIComponent(`${range!.start}T00:00:00+08:00`)
    : dateNDaysAgo(safeDays);
  const taskTo = useRange
    ? encodeURIComponent(`${range!.end}T23:59:59+08:00`)
    : null;
  const usageStartSec = useRange
    ? Math.floor(Date.parse(`${range!.start}T00:00:00+08:00`) / 1000)
    : Math.floor((Date.now() - safeDays * 86400000) / 1000);
  const usageEndSec = useRange
    ? Math.floor(Date.parse(`${range!.end}T23:59:59+08:00`) / 1000) + 1
    : Math.floor(Date.now() / 1000);

  // 本周口径统一为「最近的一周」（上一个完整的周一~周日，东八区）；
  // 月口径统一为「最近 30 天」
  const now8 = new Date(Date.now() + TZ_OFFSET_MS);
  const weekDow = (now8.getUTCDay() + 6) % 7;
  const weekStartIso = new Date(
    Date.UTC(now8.getUTCFullYear(), now8.getUTCMonth(), now8.getUTCDate()) -
      (weekDow + 7) * 86400000 -
      TZ_OFFSET_MS
  ).toISOString();
  const weekEndIso = new Date(
    Date.UTC(now8.getUTCFullYear(), now8.getUTCMonth(), now8.getUTCDate()) -
      weekDow * 86400000 -
      TZ_OFFSET_MS
  ).toISOString();
  const monthStartSec = Math.floor((Date.now() - 30 * 86400000) / 1000);

  // 并行拉取基础数据
  const [taskResult, usageResult, profileResult, staffResult, deptResult, nameByUser, priceByModel, canvasUsage, weekTasks, monthCanvas, allTimeCalls, allTimeImageTasks] =
    await Promise.all([
      restGet(
        env,
        `/rest/v1/task_submissions?select=id,user_id,type,status,created_at,completed_at,file_paths,response_file_paths,model:params-%3E%3Emodel,n_deep:params-%3Eparams-%3E%3En,n_flat:params-%3E%3En,n_count:params-%3E%3Ecount&created_at=gte.${taskFrom}${taskTo ? `&created_at=lt.${taskTo}` : ''}&order=created_at.asc&limit=50000`,
        deps
      ),
      restGet(
        env,
        `/rest/v1/generation_usage?select=user_id,period,used_count&order=period.asc&limit=50000`,
        deps
      ),
      restGet(
        env,
        `/rest/v1/user_profiles?select=user_id,department,region,oa_account,created_at&limit=50000`,
        deps
      ),
      restGet(
        env,
        `/rest/v1/staff_directory?select=oa_account,name&limit=50000`,
        deps
      ).catch(() => ({ rows: [], total: null })),
      restGet(
        env,
        `/rest/v1/departments?select=name,enabled&limit=1000`,
        deps
      ).catch(() => ({ rows: [], total: null })),
      fetchAuthDisplayNames(env, deps),
      fetchModelPricing(deps),
      fetchCanvasUsage(env, deps, usageStartSec, usageEndSec),
      countCompleted(env, deps, { fromIso: weekStartIso, toIso: weekEndIso }),
      fetchCanvasUsage(env, deps, monthStartSec, Math.floor(Date.now() / 1000)),
      countCompleted(env, deps),
      countCompleted(env, deps, { type: 'image' }),
    ]);

  const taskRows = taskResult.rows as TaskRow[];
  const usageRows = usageResult.rows as UsageRow[];
  const profileRows = profileResult.rows as ProfileRow[];
  const departmentRows = deptResult.rows as DepartmentRow[];
  const staffRows = staffResult.rows as StaffRow[];
  // Display Name 映射：staff_directory.name（按 oa_account 唯一键），花名册外回退 oa_account
  const nameByOa = new Map<string, string>(
    staffRows.map((row) => [row.oa_account, row.name])
  );

  const quotaLimit = await readQuotaLimit(env, deps);
  const tasksAgg = aggregateTasks(taskRows);
  const participation = aggregateTaskParticipation(
    taskRows,
    profileRows,
    nameByOa,
    nameByUser,
    priceByModel
  );
  // 消耗金额：KPI 优先用网关日志的真实消耗（huabu 令牌全部调用，含聊天/轮询）；
  // 部门金额无法从网关日志区分到人，按各部门估算占比分摊真实总额
  let totalCostUsd: number | null = null;
  let costByDepartment = participation.costByDepartment;
  if (canvasUsage) {
    totalCostUsd = Math.round(canvasUsage.totalUsd * 100) / 100;
    costByDepartment = scaleCostByDepartment(costByDepartment, totalCostUsd);
  } else if (priceByModel.size > 0) {
    let estimate = 0;
    for (const [model, count] of Object.entries(tasksAgg.byModel)) {
      const price = priceByModel.get(model);
      if (price !== undefined) {
        estimate += count * price;
      }
    }
    totalCostUsd = Math.round(estimate * 100) / 100;
  }
  // 美元→人民币展示汇率：configs 表 USD_CNY_RATE，缺省 0.1（内部结算口径）
  let usdCnyRate = DEFAULT_USD_CNY_RATE;
  try {
    const rawRate = await readDashboardConfig(env, 'USD_CNY_RATE', deps);
    const parsed = rawRate == null ? Number.NaN : Number(rawRate);
    if (Number.isFinite(parsed) && parsed > 0) {
      usdCnyRate = parsed;
    }
  } catch {
    // 配置缺失/查询失败用默认值
  }

  // 用量倍数：configs 表 USAGE_MULTIPLIER，缺省 1；看板所有使用次数与金额
  // 按倍数放大（仅在聚合出口处统一缩放，人数/额度/天数/汇率不受影响）
  let usageMultiplier = DEFAULT_USAGE_MULTIPLIER;
  try {
    usageMultiplier = parseUsageMultiplier(
      await readDashboardConfig(env, 'USAGE_MULTIPLIER', deps)
    );
  } catch {
    // 配置缺失/查询失败用默认值
  }

  // 领导视角：单张效果图委外参考价（CNY，configs 表 OUTSOURCE_PRICE_PER_IMAGE）
  let outsourcePriceCny: number | null = null;
  try {
    outsourcePriceCny = parseOutsourcePrice(
      await readDashboardConfig(env, OUTSOURCE_PRICE_CONFIG_KEY, deps)
    );
  } catch {
    outsourcePriceCny = null;
  }

  return applyUsageMultiplier(
    {
      generatedAt: new Date().toISOString(),
      days: safeDays,
      usdCnyRate,
      weekTasks,
      monthCostUsd: monthCanvas ? Math.round(monthCanvas.totalUsd * 100) / 100 : null,
      tasks: {
        ...tasksAgg,
        topUsers: participation.topUsers,
        userUsage: participation.userUsage,
        totalCostUsd,
      },
      usage: aggregateUsage(usageRows, profileRows, quotaLimit, nameByOa, nameByUser),
      users: {
        ...aggregateUsers(
          profileRows,
          staffResult.total ?? staffRows.length,
          departmentRows
        ),
        usageByDepartment: participation.usageByDepartment,
        usageByRegion: participation.usageByRegion,
        costByDepartment,
      },
      leadership: aggregateLeadership(taskRows, {
        tokens: canvasUsage ? canvasUsage.tokens : null,
        allTimeCalls,
        allTimeImageTasks,
        outsourcePriceCny,
        actualCostUsd: totalCostUsd,
        usdCnyRate,
      }),
    },
    usageMultiplier
  );
}

// ============================================================================
// 按钮使用统计（openspec add-button-usage-stats）
// ============================================================================

export interface ButtonUsageRow {
  button_id: string;
  button_label: string | null;
  oa_account: string;
  created_at: string;
}

export interface ButtonUsageEntry {
  buttonId: string;
  label: string;
  count: number;
  users: number;
  lastSeenAt: string;
}

export interface ButtonUsageSummary {
  /** 近 7 天排行（按点击次数降序，前 15） */
  top7d: ButtonUsageEntry[];
  /** 近 30 天排行（按点击次数降序，前 15） */
  top30d: ButtonUsageEntry[];
  /** 近 30 天按日点击合计（东八区，含 inventory 之外的点击） */
  dailyTrend: Array<{ date: string; count: number }>;
  /** 近 30 天零点击的按钮（inventory 基线差集，前 50） */
  unused: string[];
  /** inventory 基线按钮总数（零使用计算的分母口径） */
  inventoryCount: number;
}

/** 东八区 YYYY-MM-DD */
function toCstDate(ms: number): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 由 30 天窗口内的原始事件行聚合按钮使用摘要（纯函数，便于单测）。
 * - 排行：仅统计非 inv: 点击；label 取最近一次出现的非空 label
 * - 零使用：inv: 基线 − 窗口内被点击过的按钮
 */
export function buildButtonUsageSummary(
  rows: ButtonUsageRow[],
  nowMs: number = Date.now()
): ButtonUsageSummary {
  const ms7 = nowMs - 7 * 86400000;
  const ms30 = nowMs - 30 * 86400000;

  interface Acc {
    count: number;
    users: Set<string>;
    lastSeenAt: string;
    label: string;
  }
  const acc7 = new Map<string, Acc>();
  const acc30 = new Map<string, Acc>();
  const clicked30 = new Set<string>();
  const inventory = new Set<string>();
  const daily = new Map<string, number>();

  for (const row of rows) {
    const ts = Date.parse(row.created_at);
    if (!Number.isFinite(ts) || ts < ms30 || ts > nowMs) continue;
    const id = row.button_id || '';
    if (!id) continue;

    if (id.startsWith('inv:')) {
      inventory.add(id.slice(4));
      continue;
    }

    clicked30.add(id);
    const dailyKey = toCstDate(ts);
    daily.set(dailyKey, (daily.get(dailyKey) ?? 0) + 1);

    const ensure = (map: Map<string, Acc>, windowStart: number): Acc | null => {
      if (ts < windowStart) return null;
      let acc = map.get(id);
      if (!acc) {
        acc = { count: 0, users: new Set<string>(), lastSeenAt: '', label: '' };
        map.set(id, acc);
      }
      return acc;
    };
    const a7 = ensure(acc7, ms7);
    const a30 = ensure(acc30, ms30);
    for (const acc of [a7, a30]) {
      if (!acc) continue;
      acc.count += 1;
      acc.users.add(row.oa_account);
      if (ts >= Date.parse(acc.lastSeenAt || '') || !acc.lastSeenAt) {
        acc.lastSeenAt = row.created_at;
      }
      const label = (row.button_label ?? '').trim();
      if (label && !acc.label) acc.label = label;
    }
  }

  const toEntries = (map: Map<string, Acc>): ButtonUsageEntry[] =>
    [...map.entries()]
      .map(([buttonId, acc]) => ({
        buttonId,
        label: acc.label || buttonId,
        count: acc.count,
        users: acc.users.size,
        lastSeenAt: acc.lastSeenAt,
      }))
      .sort((a, b) => b.count - a.count || b.users - a.users)
      .slice(0, 15);

  const trend: Array<{ date: string; count: number }> = [...daily.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const unused = [...inventory]
    .filter((id) => !clicked30.has(id))
    .sort()
    .slice(0, 50);

  return {
    top7d: toEntries(acc7),
    top30d: toEntries(acc30),
    dailyTrend: trend,
    unused,
    inventoryCount: inventory.size,
  };
}

/** 拉取 30 天窗口内的按钮事件行（service_role 直查，绕过 RLS） */
export async function aggregateButtonUsage(
  env: DashboardEnv,
  deps: DashboardDeps = {}
): Promise<ButtonUsageSummary> {
  const from = dateNDaysAgo(30);
  const { rows } = await restGet(
    env,
    `/rest/v1/ui_click_events?select=button_id,button_label,oa_account,created_at&created_at=gte.${from}&limit=50000`,
    deps
  );
  return buildButtonUsageSummary(rows as unknown as ButtonUsageRow[]);
}

// ============================================================================
// 自定义区间校验 + 统计数据导出 Excel（openspec add-dashboard-range-export）
// ============================================================================

export interface OverviewRange {
  start: string;
  end: string;
}

export type OverviewRangeParse =
  | { ok: true; range?: OverviewRange }
  | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 真实日历日期校验（V8 Date.parse 对 2026-02-30 宽容滚动，须显式回验年月日） */
function isRealCalendarDate(s: string): boolean {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const utc = new Date(Date.UTC(y, m - 1, d));
  return (
    utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d
  );
}

/**
 * 校验 overview/export 的 start/end 区间参数（东八区，YYYY-MM-DD）。
 * 两者都缺省 → days 窗口模式（range undefined）；只给其一、格式非法、
 * 非真实日历日期或 start 晚于 end → 400 错误文案（不静默回退，避免掩盖调用方 bug）。
 */
export function parseOverviewRange(start: unknown, end: unknown): OverviewRangeParse {
  const hasStart = typeof start === 'string' && start !== '';
  const hasEnd = typeof end === 'string' && end !== '';
  if (!hasStart && !hasEnd) {
    return { ok: true };
  }
  if (hasStart !== hasEnd) {
    return { ok: false, error: 'start 与 end 需同时提供（或都不提供走 days 窗口）' };
  }
  const s = start as string;
  const e = end as string;
  if (!DATE_RE.test(s) || !DATE_RE.test(e)) {
    return { ok: false, error: 'start/end 需为 YYYY-MM-DD 格式（如 2026-08-07）' };
  }
  if (!isRealCalendarDate(s) || !isRealCalendarDate(e)) {
    return { ok: false, error: 'start/end 需为真实日历日期（如 2026-02-30 不合法）' };
  }
  if (s > e) {
    return { ok: false, error: 'start 不能晚于 end' };
  }
  return { ok: true, range: { start: s, end: e } };
}

// ----------------------------------------------------------------------------
// 零依赖 xlsx 写入器（stored ZIP + 最小 SpreadsheetML）。
// 看板函数不引外部依赖（页面自包含有测试守护），xlsx 以 stored（不压缩）条目
// 手工打包：[Content_Types].xml + rels + workbook + styles + worksheets，
// 文本用 inlineStr 单元格，数字用数值单元格。Excel/WPS 可直接打开。
// ----------------------------------------------------------------------------

export interface XlsxSheet {
  /** sheet 名（>31 字符截断；Excel 非法字符 :\\/?*[] 清洗为下划线） */
  name: string;
  rows: Array<Array<string | number | null>>;
  /** 各列显示宽度（可选，仅影响打开观感） */
  widths?: number[];
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&apos;'
  );
}

/** Excel sheet 名清洗：非法字符 :\\/?*[] → 下划线，截断到 31 字符 */
function xlsxSheetName(raw: string): string {
  return raw.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
}

function columnRef(index: number): string {
  let n = index + 1;
  let ref = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    ref = String.fromCharCode(65 + rem) + ref;
    n = Math.floor((n - 1) / 26);
  }
  return ref;
}

function sheetXml(sheet: XlsxSheet): string {
  const rowsXml = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === null || value === undefined || value === '') {
            return '';
          }
          const ref = `${columnRef(c)}${r + 1}`;
          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const colsXml = (sheet.widths || [])
    .map(
      (w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`
    )
    .join('');
  return `${XML_DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml ? `<cols>${colsXml}</cols>` : ''}<sheetData>${rowsXml}</sheetData></worksheet>`;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 打包为 stored（不压缩）ZIP：本地文件头 + 数据 + 中央目录 + EOCD。固定 DOS 时间保证产物确定性。 */
function zipStored(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number) =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const crc = crc32(file.data);
    const local = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(file.data.length),
      u32(file.data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      file.data,
    ]);
    chunks.push(local);
    central.push(
      concatBytes([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(dosTime),
        u16(dosDate),
        u32(crc),
        u32(file.data.length),
        u32(file.data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ])
    );
    offset += local.length;
  }

  const centralBytes = concatBytes(central);
  return concatBytes([
    ...chunks,
    centralBytes,
    concatBytes([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(files.length),
      u16(files.length),
      u32(centralBytes.length),
      u32(offset),
      u16(0),
    ]),
  ]);
}

/** 由 sheet 列表生成最小合法 .xlsx 字节流（零依赖，纯函数） */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const enc = new TextEncoder();
  const files: Array<{ name: string; data: Uint8Array }> = [];

  const contentTypes =
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join('') +
    '</Types>';
  files.push({ name: '[Content_Types].xml', data: enc.encode(contentTypes) });

  files.push({
    name: '_rels/.rels',
    data: enc.encode(
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    ),
  });

  files.push({
    name: 'xl/workbook.xml',
    data: enc.encode(
      `${XML_DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        sheets
          .map(
            (s, i) =>
              `<sheet name="${xmlEscape(xlsxSheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
          )
          .join('') +
        '</sheets></workbook>'
    ),
  });

  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: enc.encode(
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>'
    ),
  });

  files.push({
    name: 'xl/styles.xml',
    data: enc.encode(
      `${XML_DECL}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
        '</styleSheet>'
    ),
  });

  sheets.forEach((sheet, i) => {
    files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(sheetXml(sheet)),
    });
  });

  return zipStored(files);
}

// ----------------------------------------------------------------------------
// 看板 overview → 多 sheet 工作簿（口径与页面渲染一致）
// ----------------------------------------------------------------------------

export interface OverviewWorkbookOptions {
  /** 统计周期标签（如「2026-08-07 ~ 2026-09-30」「近 30 天」），写入概览 sheet */
  rangeLabel?: string;
  /** 按钮使用摘要（固定近 7/30 天口径，与面板一致）；提供时追加「按钮统计」sheet */
  buttonUsage?: ButtonUsageSummary | null;
}

type Cell = string | number | null;

function fmtDurationMs(ms: number): string {
  if (!ms) return '-';
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} 秒`;
  if (s < 3600) return `${(s / 60).toFixed(1)} 分钟`;
  return `${(s / 3600).toFixed(1)} 小时`;
}

function sortedEntries(map: Record<string, number>): Array<[string, number]> {
  return Object.entries(map || {}).sort((a, b) => b[1] - a[1]);
}

/** 组装看板统计的完整工作簿（12 类 sheet；纯函数，/export 端点与预览脚本共用） */
export function buildOverviewWorkbook(
  overview: DashboardOverview,
  opts: OverviewWorkbookOptions = {}
): Uint8Array {
  const t = overview.tasks;
  const u = overview.users;
  const L = overview.leadership;
  const rate = overview.usdCnyRate;
  const rangeLabel = opts.rangeLabel || `近 ${overview.days} 天`;
  const sheets: XlsxSheet[] = [];

  sheets.push({
    name: '概览',
    widths: [22, 34],
    rows: [
      ['指标', '数值'],
      ['统计周期', rangeLabel],
      ['生成时间', overview.generatedAt],
      ['数据覆盖天数', overview.days],
      ['总操作次数', t.total],
      ['活跃用户数', t.activeUsers],
      ['平均耗时', fmtDurationMs(t.avgDurationMs)],
      ['消耗金额(USD)', t.totalCostUsd == null ? '-' : t.totalCostUsd],
      ['近30天消耗金额(USD)', overview.monthCostUsd == null ? '-' : overview.monthCostUsd],
      ['最近一周任务数', overview.weekTasks],
      ['汇率(USD→CNY)', rate],
    ],
  });

  sheets.push({
    name: '核心指标',
    widths: [24, 34],
    rows: [
      ['指标', '数值'],
      ['生成图片(张)', L.windowImages],
      ['生图任务次数', L.windowImageTasks],
      ['平均出图耗时', fmtDurationMs(L.avgImageDurationMs)],
      ['最常用模型', L.topModel || '-'],
      ['最常用模型次数', L.topModelCount],
      ['使用模型类型数', L.modelTypes],
      ['Token 消耗', L.tokens == null ? '-' : L.tokens],
      ['累计调用次数', L.allTimeCalls == null ? '-' : L.allTimeCalls],
      ['累计生图任务', L.allTimeImageTasks == null ? '-' : L.allTimeImageTasks],
      ['单张委外参考价(CNY)', L.outsourcePriceCny == null ? '未配置' : L.outsourcePriceCny],
      ['等效委外成本(CNY)', L.outsourceEquivalentCny == null ? '-' : L.outsourceEquivalentCny],
      ['节省委外费用(CNY)', L.savedCny == null ? '-' : L.savedCny],
    ],
  });

  const sharePct = (count: number) =>
    t.total ? `${((count / t.total) * 100).toFixed(1)}%` : '-';
  sheets.push({
    name: '操作类型分布',
    widths: [20, 12, 10],
    rows: [
      ['类型', '次数', '占比'],
      ...sortedEntries(t.byType).map(([k, v]) => [k, v, sharePct(v)] as Cell[]),
    ],
  });
  sheets.push({
    name: '模型使用分布',
    widths: [34, 12, 10],
    rows: [
      ['模型', '次数', '占比'],
      ...sortedEntries(t.byModel).map(([k, v]) => [k, v, sharePct(v)] as Cell[]),
    ],
  });

  sheets.push({
    name: '每日趋势',
    widths: [14, 10],
    rows: [
      ['日期', '次数'],
      ...(t.dailyTrend || []).map((p) => [p.date, p.count] as Cell[]),
    ],
  });
  sheets.push({
    name: '24小时分布',
    widths: [16, 10],
    rows: [
      ['小时', '次数'],
      ...(t.hourly || []).map(
        (count, hour) =>
          [
            `${String(hour).padStart(2, '0')}:00-${String((hour + 1) % 24).padStart(2, '0')}:00`,
            count,
          ] as Cell[]
      ),
    ],
  });

  sheets.push({
    name: '部门使用排行',
    widths: [20, 12],
    rows: [
      ['部门', '使用次数'],
      ...sortedEntries(u.usageByRegion).map(([k, v]) => [k, v] as Cell[]),
    ],
  });
  sheets.push({
    name: '用户使用排行',
    widths: [24, 16, 16, 12],
    rows: [
      ['用户ID', '姓名', '部门', '使用次数'],
      ...(t.userUsage || []).map(
        (row) =>
          [row.userId, row.displayName || row.userId, row.department || '-', row.count] as Cell[]
      ),
    ],
  });
  // 与页面「部门使用汇总」同口径：用户数=byDepartment、次数=usageByDepartment、
  // 金额 CNY=costByDepartment×汇率、占比=次数/总次数（1 位小数）
  sheets.push({
    name: '部门使用汇总',
    widths: [20, 10, 12, 14, 10],
    rows: [
      ['部门', '用户数', '使用次数', '金额(CNY)', '占比'],
      ...sortedEntries(u.usageByDepartment).map(([dept, count]) => {
        const costUsd = u.costByDepartment ? u.costByDepartment[dept] : undefined;
        return [
          dept,
          (u.byDepartment && u.byDepartment[dept]) || 0,
          count,
          costUsd == null ? '-' : Math.round(costUsd * rate * 100) / 100,
          t.total ? `${((count / t.total) * 100).toFixed(1)}%` : '-',
        ] as Cell[];
      }),
    ],
  });

  sheets.push({
    name: '月度用量趋势',
    widths: [14, 12],
    rows: [
      ['周期', '用量'],
      ...(overview.usage.byPeriod || []).map((p) => [p.period, p.used] as Cell[]),
    ],
  });
  sheets.push({
    name: '部门分布',
    widths: [20, 10],
    rows: [
      ['部门', '人数'],
      ...sortedEntries(u.byDepartment).map(([k, v]) => [k, v] as Cell[]),
    ],
  });

  if (opts.buttonUsage) {
    const b = opts.buttonUsage;
    const rows: Cell[][] = [['榜单', '排名', '按钮', '点击次数', '使用人数', '最近使用']];
    rows.push(
      ...(b.top7d || []).map(
        (row, i) => ['近 7 天排行', i + 1, row.label, row.count, row.users, row.lastSeenAt] as Cell[]
      )
    );
    rows.push(
      ...(b.top30d || []).map(
        (row, i) => ['近 30 天排行', i + 1, row.label, row.count, row.users, row.lastSeenAt] as Cell[]
      )
    );
    if (b.inventoryCount > 0) {
      rows.push(
        ...(b.unused || []).map(
          (label) =>
            [
              `零使用清单（近 30 天基线 ${b.inventoryCount} 个按钮）`,
              null,
              label,
              null,
              null,
              null,
            ] as Cell[]
        )
      );
    }
    sheets.push({ name: '按钮统计', widths: [30, 8, 36, 10, 10, 22], rows });
  }

  return buildXlsx(sheets);
}

// ============================================================================
// HTML 看板页面（自包含，无外部依赖）
// ============================================================================

/** 从 Authorization 头提取 Bearer token（无/格式不符返回 null） */
export function extractBearerToken(headerValue: string | null): string | null {
  const match = (headerValue || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export type DashboardGate =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string };

/**
 * 看板统一门禁：有效用户 JWT（/auth/v1/user 自证）+ 数据库统一 RPC is_admin()。
 * 未带 token / token 无效 → 401；非管理员 / RPC 不可用 → 403（fail-closed）。
 */
export async function verifyDashboardAdmin(
  env: DashboardEnv,
  request: Request,
  deps: DashboardDeps = {}
): Promise<DashboardGate> {
  const jwt = extractBearerToken(request.headers.get('Authorization'));
  if (!jwt) {
    return { ok: false, status: 401, error: 'unauthorized: missing bearer token' };
  }
  const doFetch = deps.fetch || fetch;
  const base = (env.SUPABASE_URL || '').replace(/\/$/, '');
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


/**
 * 生成自包含 HTML 看板页面。页面 JS 以相对路径调 `/overview?days=N`，
 * 数据请求带登录会话的 access_token（oa账号+密码登录，刷新令牌自动续期）。
 */
export function buildDashboardHtml(anonKey: string): string {
  const safeKey = anonKey.replace(/[<>&'"]/g, '');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数据看板 · AI 平台</title>
<style>
  :root { --bg:#070b16; --card:rgba(255,255,255,.035); --card2:rgba(148,163,184,.09); --line:rgba(148,163,184,.14); --text:#e8eefc; --muted:#8b98b3; --accent:#5b8cff; --accent2:#22d3ee; --ok:#34d399; --fail:#f87171; --warn:#fbbf24; --radius:14px; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; -webkit-font-smoothing:antialiased; padding:0 0 36px; }
  body::before { content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
    background: radial-gradient(640px 320px at 12% -6%, rgba(91,140,255,.16), transparent 62%),
                radial-gradient(720px 340px at 88% -8%, rgba(34,211,238,.11), transparent 62%); }
  header { position:sticky; top:0; z-index:10; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
    padding:14px 26px; background:rgba(7,11,22,.74); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border-bottom:1px solid var(--line); }
  h1 { font-size:18px; font-weight:700; letter-spacing:.5px; background:linear-gradient(90deg,#a5c4ff,#22d3ee); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .wrap { position:relative; z-index:1; max-width:1280px; margin:0 auto; padding:6px 26px 0; }
  .controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  button, select, input[type="date"] { background:rgba(148,163,184,.1); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 12px; font-size:13px; cursor:pointer; transition:.15s; color-scheme:dark; }
  button:hover, select:hover, input[type="date"]:hover { border-color:var(--accent); background:rgba(91,140,255,.12); }
  .meta { color:var(--muted); font-size:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:14px; margin:16px 0; }
  .cards.small { grid-template-columns:repeat(auto-fit,minmax(175px,1fr)); }
  .card { position:relative; overflow:hidden; background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015));
    border:1px solid var(--line); border-radius:var(--radius); padding:16px 18px; transition:transform .18s, border-color .18s, box-shadow .18s; }
  .card:hover { transform:translateY(-2px); border-color:rgba(91,140,255,.45); box-shadow:0 10px 26px rgba(0,0,0,.35); }
  .card::before { content:''; position:absolute; top:0; left:0; right:0; height:1px;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,.2),transparent); }
  .card .label { color:var(--muted); font-size:12px; margin-bottom:8px; letter-spacing:.3px; }
  .card .value { font-size:26px; font-weight:700; letter-spacing:-.3px; font-variant-numeric:tabular-nums; }
  .card .sub { color:var(--muted); font-size:12px; margin-top:6px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:14px; margin-bottom:14px; }
  .panel { background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.015)); border:1px solid var(--line);
    border-radius:var(--radius); padding:18px; animation:fadeUp .45s ease both; transition:border-color .18s; }
  .grid .panel:nth-child(2) { animation-delay:.06s; }
  .grid .panel:nth-child(3) { animation-delay:.12s; }
  .panel:hover { border-color:rgba(91,140,255,.35); }
  .panel h2 { font-size:13px; font-weight:600; margin-bottom:14px; color:var(--text); display:flex; align-items:center; gap:8px; }
  .panel h2::before { content:''; width:3px; height:12px; border-radius:2px; background:linear-gradient(180deg,var(--accent),var(--accent2)); }
  .bar-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:12px; }
  .bar-row .name { width:110px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--muted); }
  .bar-row .track { flex:1; height:12px; background:var(--card2); border-radius:6px; overflow:hidden; }
  .bar-row .fill { height:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); border-radius:6px; }
  .bar-row .num { width:56px; text-align:right; font-variant-numeric:tabular-nums; }
  .rank-scroll { max-height:420px; overflow-y:auto; padding-right:4px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid rgba(148,163,184,.09); }
  th { color:var(--muted); font-weight:500; }
  tbody tr { transition:background .12s; }
  tbody tr:hover { background:rgba(91,140,255,.07); }
  .legend { display:flex; gap:12px; font-size:12px; color:var(--muted); margin-bottom:10px; flex-wrap:wrap; }
  .legend span i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:5px; }
  .chip { transition:transform .15s; }
  .chip:hover { transform:translateY(-2px); }
  svg { width:100%; height:auto; display:block; }
  svg text { font-family:inherit; }
  .sk { min-height:120px; border-radius:10px; background:linear-gradient(100deg,rgba(255,255,255,.04) 30%,rgba(255,255,255,.09) 50%,rgba(255,255,255,.04) 70%); background-size:200% 100%; animation:shimmer 1.2s linear infinite; }
  @keyframes shimmer { to { background-position:-200% 0; } }
  @keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  .error { color:var(--fail); padding:20px; text-align:center; }
  .muted { color:var(--muted); }
  /* 登录遮罩（仅管理员可见看板） */
  #loginCard { position:fixed; inset:0; z-index:60; display:none; align-items:center; justify-content:center;
    background:radial-gradient(720px 360px at 50% 18%, rgba(91,140,255,.14), transparent 65%), var(--bg); }
  #loginCard .login-box { width:min(360px,92vw); background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:28px 26px; }
  #loginCard h1 { font-size:17px; margin-bottom:6px; }
  #loginCard .sub { color:var(--muted); font-size:12px; margin-bottom:18px; }
  #loginCard input { width:100%; background:rgba(148,163,184,.1); color:var(--text); border:1px solid var(--line);
    border-radius:8px; padding:9px 12px; font-size:13px; margin-bottom:10px; outline:none; }
  #loginCard input:focus { border-color:var(--accent); }
  #loginBtn { width:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); color:#fff; border:none;
    border-radius:8px; padding:10px 12px; font-size:13px; font-weight:600; cursor:pointer; }
  #loginBtn:disabled { opacity:.6; cursor:default; }
  #loginMsg { color:var(--fail); font-size:12px; min-height:16px; margin-top:10px; text-align:center; }
</style>
</head>
<body>
<header>
  <h1>YUE 画布数据看板</h1>
  <div class="controls">
    <span class="meta" id="generatedAt"></span>
    <select id="daysSel">
      <option value="week" selected>最近一周（周一~周日）</option>
      <option value="30">近 30 天</option>
      <option value="90">近 90 天</option>
      <option value="custom">自定义区间…</option>
    </select>
    <span id="customRangeBox" style="display:none">
      <input type="date" id="rangeStart" aria-label="起始日期">
      <span class="meta">~</span>
      <input type="date" id="rangeEnd" aria-label="结束日期">
      <button id="applyRangeBtn">应用</button>
    </span>
    <button id="refreshBtn">刷新</button>
    <button id="exportBtn">导出图片</button>
    <button id="exportXlsxBtn" title="导出当前统计区间全部统计数据为 Excel（.xlsx），与页面各面板同口径">导出Excel</button>
    <button id="pushBtn">推送</button>
    <button id="pushTestBtn" title="用 DEV_DINGTALK_WEBHOOK 配置向开发群推送完整周报（需 DEV_DINGTALK_SECRET 强制加签；结果以钉钉群实际收到为准，页面不回显）">推送测试</button>
    <button id="copyReportBtn">复制报告</button>
    <button id="logoutBtn" title="退出登录">退出</button>
  </div>
</header>
<div class="wrap">

<div class="cards" id="kpiCards"><div class="sk"></div></div>

<div class="grid">
  <div class="panel"><h2>核心指标</h2><div class="cards small" id="leaderCards" style="margin:0"><div class="sk"></div></div></div>
</div>

<div class="grid">
  <div class="panel"><h2>操作类型分布</h2><div id="typeDonut"><div class="sk"></div></div></div>
  <div class="panel"><h2>模型使用分布</h2><div id="modelDonut"><div class="sk"></div></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>日历使用热力（当月）</h2><div id="calendarHeat"><div class="sk"></div></div></div>
  <div class="panel"><h2>24小时使用分布</h2><div id="hourlyChart"><div class="sk"></div></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>每日成功任务趋势（近 <span id="trendDays"></span> 天）</h2><svg id="trendChart" viewBox="0 0 680 220"></svg></div>
</div>
<div class="grid">
  <div class="panel"><h2>部门使用排行</h2><div id="rankTable"><div class="sk"></div></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>用户使用排行<span id="userRankCount" style="margin-left:8px;font-size:12px;color:var(--muted);font-weight:400"></span></h2><div id="userRank" class="rank-scroll"><div class="sk"></div></div></div>
  <div class="panel"><h2>按钮使用统计<span style="margin-left:8px;font-size:12px;color:var(--muted);font-weight:400">近 7 / 30 天 · 零使用基线=启动清单</span></h2>
    <div id="buttonUsage"><div class="sk"></div></div>
  </div>
</div>
<div class="grid">
  <div class="panel"><h2>部门使用汇总</h2><table id="deptSummary"><thead><tr><th>部门</th><th>用户数</th><th>使用次数</th><th>金额</th><th>占比</th></tr></thead><tbody></tbody></table></div>
  <div class="panel"><h2>月度用量趋势</h2><div id="usageTrend"><div class="sk"></div></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>部门分布</h2><div id="byDept"><div class="sk"></div></div></div>
</div>
</div>

<div id="loginCard">
  <div class="login-box">
    <h1>YUE 画布数据看板</h1>
    <div class="sub">仅管理员可见，请使用平台账号（oa账号）登录</div>
    <input id="loginAccount" placeholder="oa账号（小写）" autocomplete="username">
    <input id="loginPassword" type="password" placeholder="密码" autocomplete="current-password">
    <button id="loginBtn">登录</button>
    <div id="loginMsg"></div>
  </div>
</div>

<script>
var ANON_KEY = "${safeKey}";
var days = 30;

// ==================== 登录会话（oa账号+密码 → GoTrue，仅管理员可用看板） ====================
var SESSION_KEY = 'dash_admin_session';
var session = null; // { access_token, refresh_token }

function loadSession(){ try{ session = JSON.parse(localStorage.getItem(SESSION_KEY)||'null'); }catch(e){ session=null; } if(!session||!session.access_token) session=null; }
function saveSession(s){ session=s; try{ localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }catch(e){} }
function clearSession(){ session=null; try{ localStorage.removeItem(SESSION_KEY); }catch(e){} }

// 与主应用一致：纯 oa账号补 @yjk.com（自动转小写），含 @ 视为完整邮箱
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
        showLoginMsg(''); hideLogin(); load();
      } else if(res.body && (res.body.error_description||res.body.msg||'').indexOf('expire')>=0){
        showLoginMsg('登录已过期，请重新登录');
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


function fmtDate(iso){ if(!iso) return '-'; var d=new Date(iso); if(isNaN(d)) return iso; var p=function(x){return String(x).padStart(2,'0')}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
function fmtBytes(n){ if(n==null) return '-'; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KB'; if(n<1073741824) return (n/1048576).toFixed(1)+' MB'; return (n/1073741824).toFixed(2)+' GB'; }
function esc(s){ return String(s==null?'-':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function fmtDur(ms){ if(!ms) return '-'; var s=ms/1000; if(s<60) return Math.round(s)+' 秒'; if(s<3600) return (s/60).toFixed(1)+' 分钟'; return (s/3600).toFixed(1)+' 小时'; }
function fmtInt(v){ return v==null ? '-' : Number(v).toLocaleString('en-US'); }
function fmtMoney0(v){ return v==null ? '-' : (v<0?'-':'')+'¥'+Math.abs(Number(v)).toLocaleString('en-US',{maximumFractionDigits:0}); }

function bars(el, data, color){
  var entries = Object.entries(data||{}).sort(function(a,b){return b[1]-a[1];});
  var max = entries.reduce(function(m,e){return Math.max(m,e[1]);}, 1);
  el.innerHTML = entries.length ? entries.map(function(e){
    var w = Math.max(2, Math.round(e[1]/max*100));
    return '<div class="bar-row"><span class="name" title="'+esc(e[0])+'">'+esc(e[0])+'</span><div class="track"><div class="fill" style="width:'+w+'%;background:'+color+'"></div></div><span class="num">'+e[1]+'</span></div>';
  }).join('') : '<div class="muted">暂无数据</div>';
}

function trendLine(svg, data){
  var points = data||[];
  var W=680, H=210, pad=34;
  if(!points.length){
    svg.innerHTML='<text x="340" y="100" text-anchor="middle" fill="#8b98b3" font-size="13">暂无数据</text>';
    return;
  }
  var max = Math.max.apply(null, points.map(function(p){return p.count;})) || 1;
  var n = points.length;
  var stepX = (W-pad*2)/Math.max(1,n-1);
  var coords = points.map(function(p,i){
    return [pad + i*stepX, H-pad+8 - (p.count/max)*(H-pad*2-12)];
  });
  // 平滑曲线（相邻点水平中点作控制点）
  var d = 'M'+coords[0][0].toFixed(1)+','+coords[0][1].toFixed(1);
  for(var i=1;i<n;i++){
    var p0=coords[i-1], p1=coords[i], cx=((p0[0]+p1[0])/2).toFixed(1);
    d += ' C'+cx+','+p0[1].toFixed(1)+' '+cx+','+p1[1].toFixed(1)+' '+p1[0].toFixed(1)+','+p1[1].toFixed(1);
  }
  var area = d + ' L'+coords[n-1][0].toFixed(1)+','+(H-pad+8)+' L'+pad+','+(H-pad+8)+' Z';
  var grid='';
  for(var g=1;g<=3;g++){
    var gy=(H-pad+8)-(g/3)*(H-pad*2-12);
    grid+='<line x1="'+pad+'" y1="'+gy.toFixed(1)+'" x2="'+(W-pad)+'" y2="'+gy.toFixed(1)+'" stroke="rgba(148,163,184,.12)" stroke-dasharray="3 4"/>';
  }
  var last = coords[n-1];
  svg.innerHTML =
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b8cff" stop-opacity="0.32"/><stop offset="1" stop-color="#5b8cff" stop-opacity="0"/></linearGradient></defs>'+
    grid+
    '<path d="'+area+'" fill="url(#g)"/>'+
    '<path d="'+d+'" fill="none" stroke="#5b8cff" stroke-width="2.5" stroke-linecap="round" style="filter:drop-shadow(0 0 6px rgba(91,140,255,.5))"/>'+
    '<circle cx="'+last[0].toFixed(1)+'" cy="'+last[1].toFixed(1)+'" r="4" fill="#22d3ee"><animate attributeName="r" values="4;6.5;4" dur="2s" repeatCount="indefinite"/></circle>'+
    '<text x="'+pad+'" y="'+(H-pad+26)+'" fill="#8b98b3" font-size="10">'+esc(points[0].date)+'</text>'+
    '<text x="'+(W-pad)+'" y="'+(H-pad+26)+'" fill="#8b98b3" font-size="10" text-anchor="end">'+esc(points[n-1].date)+'</text>'+
    '<text x="'+pad+'" y="15" fill="#8b98b3" font-size="11">峰值 '+max+'</text>';
}

var CHART_COLORS = ['#4f8cff','#34d399','#fbbf24','#f472b6','#c084fc','#f97316','#22d3ee','#a3e635','#fb7185','#60a5fa'];
var USD_CNY = 0.1; // 兜底汇率；实际以 overview 返回的 usdCnyRate（configs 表 USD_CNY_RATE）为准
var LAST_OVERVIEW = null;

function sparkline(trend){
  var pts=(trend||[]).slice(-14);
  if(pts.length<2) return '';
  var max=Math.max.apply(null,pts.map(function(p){return p.count;}))||1;
  var W=100,H=30, step=W/(pts.length-1);
  var poly=pts.map(function(p,i){return (i*step).toFixed(1)+','+(H-3-(p.count/max)*(H-7)).toFixed(1);}).join(' ');
  var area=poly+' '+W+','+H+' 0,'+H;
  return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" style="width:100%;height:30px;margin-top:10px;display:block">'+
    '<polygon points="'+area+'" fill="rgba(34,211,238,.12)"/>'+
    '<polyline points="'+poly+'" fill="none" stroke="#22d3ee" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}

function kpiCards(o){
  var t = o.tasks, u = o.users, q = o.usage;
  var costVal = t.totalCostUsd == null ? '-' : '¥' + (t.totalCostUsd * USD_CNY).toFixed(2);
  var costSub = t.totalCostUsd == null ? '暂无计费数据源' : '';
  var big = [
    ['总操作次数（近 '+o.days+' 天）', t.total, '日均 '+(t.total/Math.max(1,o.days)).toFixed(1)+' · 平均耗时 '+fmtDur(t.avgDurationMs), sparkline(t.dailyTrend)],
    ['最近一周用量', o.weekTasks, '周一 ~ 周日', ''],
    ['消耗金额', costVal, costSub, ''],
    ['近30天消耗金额', o.monthCostUsd==null?'-':'¥'+(o.monthCostUsd*USD_CNY).toFixed(2), '近 30 天', ''],
    ['活跃用户数', t.activeUsers, '', ''],
    ['本月用量', q.latestUsed, '周期 '+(q.latestPeriod||'-'), ''],
    ['数据覆盖天数', o.days, '截至 '+fmtDate(o.generatedAt).slice(0,10), ''],
  ];
  // 固定「近 30 天」口径的消耗卡仅在近 30 天周期显示；其余周期（周/月/90 天）隐藏，避免口径错位
  if(CURRENT_MODE!=='30'){
    big = big.filter(function(c){ return c[0]!=='近30天消耗金额'; });
  }
  document.getElementById('kpiCards').innerHTML = big.map(function(c){
    return '<div class="card"><div class="label">'+esc(c[0])+'</div><div class="value" style="font-size:30px">'+esc(c[1])+'</div><div class="sub">'+esc(c[2])+'</div>'+(c[3]||'')+'</div>';
  }).join('');
}

// 领导视角 · 核心指标（产出/消耗/累计/降本，对照课题汇报数据清单口径）
function leaderCards(o){
  var L = o.leadership || {};
  var savedSub = L.outsourcePriceCny == null
    ? '在 configs 表配置 OUTSOURCE_PRICE_PER_IMAGE（元/张）后启用'
    : '等效委外 ' + fmtMoney0(L.outsourceEquivalentCny) + '（参考价 ¥' + L.outsourcePriceCny + '/张）';
  var cards = [
    ['累计调用次数（成功）', fmtInt(L.allTimeCalls), '全时段累计 · 窗口内 ' + (o.tasks ? o.tasks.total : 0) + ' 次'],
    ['生成图片', fmtInt(L.windowImages) + ' 张', (L.windowImageTasks||0) + ' 次生图任务 · 累计 ' + fmtInt(L.allTimeImageTasks) + ' 次'],
    ['Token 消耗（近 ' + o.days + ' 天）', fmtInt(L.tokens), L.tokens==null ? '网关日志未含 token 字段' : '网关日志汇总（prompt+completion）'],
    ['最常用模型', L.topModel || '-', (L.modelTypes||0) + ' 种模型' + (L.topModel ? ' · ' + fmtInt(L.topModelCount) + ' 次' : '')],
    ['平均出图耗时', L.avgImageDurationMs ? fmtDur(L.avgImageDurationMs) : '-', '生图任务窗口均值 · 全任务 ' + fmtDur(o.tasks ? o.tasks.avgDurationMs : 0)],
    ['节省委外费用（估算）', fmtMoney0(L.savedCny), savedSub],
  ];
  document.getElementById('leaderCards').innerHTML = cards.map(function(c){
    return '<div class="card"><div class="label">'+esc(c[0])+'</div><div class="value" style="font-size:22px;overflow-wrap:anywhere">'+esc(c[1])+'</div><div class="sub">'+esc(c[2])+'</div></div>';
  }).join('');
}

function donut(el, data){
  var entries = Object.entries(data||{}).filter(function(e){return e[1]>0;}).sort(function(a,b){return b[1]-a[1];});
  var total = entries.reduce(function(s,e){return s+e[1];},0);
  if(!total){ el.innerHTML = '<div class="muted">暂无数据</div>'; return; }
  var top = entries.slice(0,9);
  var rest = entries.slice(9);
  if(rest.length){ top.push(['其他', rest.reduce(function(s,e){return s+e[1];},0)]); }
  var acc=0, stops=[];
  top.forEach(function(e,i){
    var from=acc/total*360; acc+=e[1]; var to=acc/total*360;
    var c=CHART_COLORS[i%CHART_COLORS.length];
    stops.push(c+' '+(from+1.5).toFixed(1)+'deg '+(to-1.5<from+1.5?to:to-1.5).toFixed(1)+'deg');
  });
  el.innerHTML = '<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">'+
    '<div style="width:150px;height:150px;border-radius:50%;flex:none;background:conic-gradient('+stops.join(',')+');position:relative;box-shadow:0 6px 18px rgba(0,0,0,.3)">'+
    '<div style="position:absolute;inset:26%;border-radius:50%;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center">'+
    '<span style="font-size:17px;font-weight:700;font-variant-numeric:tabular-nums">'+total+'</span><span class="muted" style="font-size:10px">总计</span></div></div>'+
    '<div style="display:flex;flex-direction:column;gap:4px;min-width:150px">'+top.map(function(e,i){
      return '<span class="legend" style="margin:0"><i style="background:'+CHART_COLORS[i%CHART_COLORS.length]+'"></i>'+esc(e[0])+' <b>'+e[1]+'</b>（'+(e[1]/total*100).toFixed(1)+'%）</span>';
    }).join('')+'</div></div>';
}

function rankChips(el, list){
  el.style.display='flex'; el.style.gap='8px'; el.style.flexWrap='wrap';
  var medals=['#fbbf24','#cbd5e1','#f59e0b'];
  el.innerHTML = (list||[]).map(function(r,i){
    var name = r.displayName || '-';
    var ring = i<3 ? medals[i] : 'transparent';
    return '<div class="chip" style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 8px;background:var(--card2);border-radius:10px;min-width:66px;flex:1">'+
      '<div style="position:relative;width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid '+ring+'">'+esc(name.charAt(0))+
      (i<3?'<span style="position:absolute;top:-6px;right:-6px;font-size:10px">'+(i===0?'🥇':i===1?'🥈':'🥉')+'</span>':'')+'</div>'+
      '<div style="font-size:11px;color:var(--muted);max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(name)+'">'+esc(name)+'</div>'+
      '<div style="font-size:14px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">'+r.count+'</div></div>';
  }).join('') || '<div class="muted">暂无数据</div>';
}

function calendarHeat(el, trend){
  var m={}; (trend||[]).forEach(function(p){ m[p.date]=p.count; });
  var now=new Date(); var y=now.getFullYear(), mo=now.getMonth();
  var pad=function(x){return String(x).padStart(2,'0');};
  var firstDow=(new Date(y,mo,1).getDay()+6)%7;
  var dim=new Date(y,mo+1,0).getDate();
  var max=0; for(var d=1;d<=dim;d++){ max=Math.max(max, m[y+'-'+pad(mo+1)+'-'+pad(d)]||0); }
  var html='<div style="display:flex;gap:6px;margin-bottom:6px"><span class="muted" style="width:26px;text-align:center">'+(mo+1)+'月</span>'+
    ['一','二','三','四','五','六','日'].map(function(d){return '<span class="muted" style="width:26px;text-align:center">'+d+'</span>';}).join('')+'</div>';
  html+='<div style="display:grid;grid-template-columns:repeat(7,max-content);gap:6px">';
  for(var i=0;i<firstDow;i++) html+='<span style="width:26px"></span>';
  for(var d=1;d<=dim;d++){
    var ds=y+'-'+pad(mo+1)+'-'+pad(d); var c=m[ds]||0;
    var bg=c>0?'rgba(79,140,255,'+(0.18+0.82*(c/max)).toFixed(3)+')':'var(--card2)';
    html+='<div title="'+ds+'：'+c+' 次" style="width:26px;height:30px;border-radius:6px;background:'+bg+';display:flex;align-items:center;justify-content:center;font-size:10px;color:'+(c>0?'#e6ecf7':'#5b6884')+'">'+d+'</div>';
  }
  html+='</div>';
  html+='<div class="muted" style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:11px">少 '+
    [0.15,0.4,0.7,1].map(function(a){return '<span style="width:14px;height:12px;border-radius:3px;background:rgba(79,140,255,'+a+')"></span>';}).join('')+' 多</div>';
  el.innerHTML=html;
}

function hourlyBars(el, hourly){
  var a = hourly||[]; var max = Math.max.apply(null, a.length?a:[0]) || 1;
  var W=680,H=190,pad=24, bw=(W-pad*2)/24;
  var svg='<defs><linearGradient id="hb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#3b5fd9" stop-opacity=".5"/></linearGradient></defs>';
  svg+='<line x1="'+pad+'" y1="'+(H-pad)+'" x2="'+(W-pad)+'" y2="'+(H-pad)+'" stroke="rgba(148,163,184,.18)"/>';
  for(var h=0;h<24;h++){
    var c=a[h]||0; var hgt=c/max*(H-pad*2-8); var x=pad+h*bw;
    svg+='<rect x="'+x.toFixed(1)+'" y="'+(H-pad-Math.max(0,hgt)).toFixed(1)+'" width="'+(bw-3).toFixed(1)+'" height="'+Math.max(0,hgt).toFixed(1)+'" rx="3" fill="url(#hb)"><title>'+h+':00　'+c+' 次</title></rect>';
    if(c>0) svg+='<text x="'+(x+bw/2-1.5).toFixed(1)+'" y="'+(H-pad-hgt-5).toFixed(1)+'" fill="#8b98b3" font-size="9" text-anchor="middle">'+c+'</text>';
    if(h%2===0) svg+='<text x="'+(x+bw/2-1.5).toFixed(1)+'" y="'+(H-6)+'" fill="#8b98b3" font-size="9" text-anchor="middle">'+h+'h</text>';
  }
  el.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;display:block">'+svg+'</svg>';
}

function rankTable(el, o){
  var total = o.tasks.total;
  var rows = Object.entries(o.users.usageByRegion||{}).sort(function(a,b){return b[1]-a[1];});
  el.innerHTML = '<table><thead><tr><th>排名</th><th>名称</th><th>使用次数</th><th>占比</th></tr></thead><tbody>'+
    (rows.length?rows.map(function(r,i){
      return '<tr><td>'+(i+1)+'</td><td>'+esc(r[0])+'</td><td>'+r[1]+'</td><td>'+(total?(r[1]/total*100).toFixed(1)+'%':'-')+'</td></tr>';
    }).join(''):'<tr><td colspan="4" class="muted">暂无数据</td></tr>')+'</tbody></table>';
}

function buildReportText(o, rangeLabel){
  var t=o.tasks, u=o.users, L=o.leadership||{};
  var cost=(t.totalCostUsd==null)?'—':'¥'+(t.totalCostUsd*USD_CNY).toFixed(2);
  var lines=[];
  lines.push('【YUE 画布使用周报】');
  lines.push('统计周期：'+rangeLabel);
  lines.push('1. 总操作次数：'+t.total+' 次（日均 '+(t.total/Math.max(1,o.days)).toFixed(1)+' 次），活跃用户 '+t.activeUsers+' 人');
  lines.push('2. 生成图片：'+(L.windowImages||0)+' 张（'+(L.windowImageTasks||0)+' 次生图任务，平均出图 '+fmtDur(L.avgImageDurationMs)+'），累计调用 '+fmtInt(L.allTimeCalls)+' 次');
  lines.push('3. Token 消耗：'+(L.tokens==null?'—':fmtInt(L.tokens))+'；使用模型 '+(L.modelTypes||0)+' 种，最常用 '+(L.topModel||'—'));
  lines.push('4. 节省委外费用（估算）：'+(L.savedCny==null?'—（未配置 OUTSOURCE_PRICE_PER_IMAGE）':fmtMoney0(L.savedCny)+'（等效委外 '+fmtMoney0(L.outsourceEquivalentCny)+'，参考价 ¥'+L.outsourcePriceCny+'/张）'));
  lines.push('5. 消耗金额：'+cost);
  var ms=Object.entries(t.byModel||{}).sort(function(a,b){return b[1]-a[1];}).slice(0,2).map(function(e){return e[0]+' '+e[1]+' 次';}).join('、');
  lines.push('6. 热门模型：'+(ms||'—'));
  var ds=Object.entries(u.usageByRegion||{}).sort(function(a,b){return b[1]-a[1];}).slice(0,3).map(function(e){return e[0]+' '+e[1]+' 次';}).join('、');
  lines.push('7. 各部门使用：'+(ds||'—'));
  lines.push('');
  lines.push('看板地址：'+location.origin+basePath());
  return lines.join('\\n');
}

function render(o){
  LAST_OVERVIEW = o;
  var rate = Number(o.usdCnyRate);
  if(Number.isFinite(rate) && rate>0) USD_CNY = rate;
  document.getElementById('generatedAt').textContent = '统计周期 '+CURRENT_RANGE_LABEL+' · 生成于 ' + fmtDate(o.generatedAt);
  kpiCards(o);
  leaderCards(o);
  donut(document.getElementById('typeDonut'), o.tasks.byType);
  donut(document.getElementById('modelDonut'), o.tasks.byModel);
  calendarHeat(document.getElementById('calendarHeat'), o.tasks.dailyTrend);
  hourlyBars(document.getElementById('hourlyChart'), o.tasks.hourly);
  document.getElementById('trendDays').textContent = o.days;
  trendLine(document.getElementById('trendChart'), o.tasks.dailyTrend);
  rankTable(document.getElementById('rankTable'), o);
  var summaryRows = Object.entries(o.users.usageByDepartment||{}).sort(function(a,b){return b[1]-a[1];});
  var usersByDept = o.users.byDepartment||{};
  var costByDept = o.users.costByDepartment||{};
  var total = o.tasks.total;
  document.getElementById('deptSummary').querySelector('tbody').innerHTML =
    (summaryRows.length?summaryRows.map(function(e){
      var cost = costByDept[e[0]];
      return '<tr><td>'+esc(e[0])+'</td><td>'+esc(usersByDept[e[0]]||0)+'</td><td>'+e[1]+'</td><td>'+(cost!=null?'¥'+(cost*USD_CNY).toFixed(2):'-')+'</td><td>'+(total?(e[1]/total*100).toFixed(1)+'%':'-')+'</td></tr>';
    }).join(''):'<tr><td colspan="5" class="muted">暂无数据</td></tr>');
  bars(document.getElementById('byDept'), o.users.byDepartment, '#c084fc');
  bars(document.getElementById('usageTrend'), (o.usage.byPeriod||[]).reduce(function(m,p){m[p.period]=p.used;return m;},{}), '#f472b6');
  // 用户使用排行（全量）：数组渲染避免同名用户在 Object 键上互相覆盖
  var userUsage = (o.tasks.userUsage||[]);
  var userRankEl = document.getElementById('userRank');
  if(userRankEl){
    var uMax = userUsage.reduce(function(m,u){return Math.max(m,u.count);},1);
    userRankEl.innerHTML = userUsage.length ? userUsage.map(function(u,i){
      var w = Math.max(2, Math.round(u.count/uMax*100));
      var label = (i+1)+'. '+(u.displayName||u.userId||'未知用户')+(u.department?'（'+u.department+'）':'');
      return '<div class="bar-row"><span class="name" title="'+esc(label)+'">'+esc(label)+'</span><div class="track"><div class="fill" style="width:'+w+'%;background:#38bdf8"></div></div><span class="num">'+u.count+'</span></div>';
    }).join('') : '<div class="muted">暂无数据</div>';
  }
  var userRankCount = document.getElementById('userRankCount');
  if(userRankCount) userRankCount.textContent = userUsage.length ? '共 '+userUsage.length+' 人' : '';
}

function basePath(){
  var p = location.pathname.replace(/\\/+$/, '');
  p = p.replace(/\\/index\\.html$/, '');
  return p + '/';
}

var CURRENT_RANGE_LABEL = '';
// 当前周期模式：'30'（近 30 天）/ '90' / 'week' / 'month:YYYY-MM' / 'custom'（自定义区间）。
// 固定「近 30 天」口径的卡片仅在 '30' 模式显示（页面与导出图片同源渲染）。
var CURRENT_MODE = '30';
// 当前查询对应的导出请求串（load 时同步更新，导出 Excel 复用同一区间）
var LAST_EXPORT_QS = '';

function weekRange(){
  var now=new Date();
  var dow=(now.getDay()+6)%7; // 周一=0
  var mon=new Date(now.getFullYear(),now.getMonth(),now.getDate()-7-dow); // 上周一（完整周期）
  var sun=new Date(mon.getFullYear(),mon.getMonth(),mon.getDate()+6);
  var p=function(x){return String(x).padStart(2,'0');};
  var f=function(d){return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());};
  return {start:f(mon),end:f(sun),label:f(mon)+' ~ '+f(sun)};
}

// 自然月精确区间（东八区口径与后端 range 一致）：start=当月 1 日，end=当月末日
function monthRange(ym){
  var parts=ym.split('-');
  var y=Number(parts[0]), m=Number(parts[1]);
  var mm=(m<10?'0':'')+m;
  var last=new Date(y, m, 0).getDate(); // m 月末日：取 m 月的下月第 0 天
  var dd=function(d){return (d<10?'0':'')+d;};
  return {
    start:y+'-'+mm+'-01',
    end:y+'-'+mm+'-'+dd(last),
    label:ym+'（自然月）',
    days:last,
  };
}

// 月份快选：仅提供 2026-08 / 2026-09（用户拍板：看板数据仅这两个月，需要扩展时改此数组）
var MONTH_OPTIONS = ['2026-09', '2026-08'];
function populateMonthOptions(){
  var sel=document.getElementById('daysSel');
  if(!sel) return;
  // 月份快选插到「自定义区间…」之前，保持自定义项为最后一个选项
  var anchor=sel.querySelector('option[value=custom]');
  (anchor||sel).insertAdjacentHTML('beforebegin', MONTH_OPTIONS.map(function(ym){
    return '<option value="month:'+ym+'">'+ym+'（自然月）</option>';
  }).join(''));
}

async function load(){
  var mode = document.getElementById('daysSel').value;
  var qs;
  if(mode.indexOf('month:')===0){
    // 自然月快选：按月拼精确区间（后端 range 口径，东八区）
    var mr=monthRange(mode.slice(6));
    CURRENT_RANGE_LABEL=mr.label;
    days=mr.days;
    CURRENT_MODE=mode;
    qs='overview?start='+mr.start+'&end='+mr.end+'&days='+mr.days;
  } else if(mode==='week'){
    var r=weekRange();
    CURRENT_RANGE_LABEL=r.label+'（周一~周日）';
    days=7;
    CURRENT_MODE='week';
    qs='overview?start='+r.start+'&end='+r.end+'&days=7';
  } else if(mode==='custom'){
    // 自定义区间：东八区 YYYY-MM-DD，后端按 start 00:00:00 ~ end 23:59:59 过滤
    var s=document.getElementById('rangeStart').value;
    var e=document.getElementById('rangeEnd').value;
    if(!s||!e){ alert('请先选择起始与结束日期'); return; }
    if(s>e){ alert('起始日期不能晚于结束日期'); return; }
    var n=Math.round((Date.parse(e+'T00:00:00')-Date.parse(s+'T00:00:00'))/86400000)+1;
    if(!(n>0)){ alert('日期区间无效'); return; }
    CURRENT_RANGE_LABEL=s+' ~ '+e;
    days=n;
    CURRENT_MODE='custom';
    qs='overview?start='+s+'&end='+e+'&days='+n;
  } else {
    days=Number(mode)||30;
    CURRENT_RANGE_LABEL='近 '+days+' 天';
    CURRENT_MODE=String(days);
    qs='overview?days='+days;
  }
  // 导出 Excel 复用当前区间（export 与 overview 参数完全一致）
  LAST_EXPORT_QS='export?'+qs.split('?')[1];
  var requestOverview = function(){
    return fetch(basePath() + qs, { headers: authHeaders() });
  };
  try {
    var res = await requestOverview();
    if(res.status===401){
      // access token 过期：用 refresh token 续期后重试一次
      if(await tryRefresh()){ res = await requestOverview(); }
      if(res.status===401){ clearSession(); showLogin(); return; }
    }
    if(res.status===403){
      throw new Error('仅管理员可查看本看板（当前账号未授权）');
    }
    if(!res.ok){ throw new Error('HTTP ' + res.status); }
    render(await res.json());
    loadButtonUsage();
  } catch(err){
    document.getElementById('kpiCards').innerHTML =
      '<div class="card" style="grid-column:1/-1"><div class="error">加载失败：'+esc(err && err.message ? err.message : err)+'</div></div>';
  }
}

var LAST_BUTTON_USAGE = null;
async function loadButtonUsage(){
  var host = document.getElementById('buttonUsage');
  try{
    var request = function(){ return fetch(basePath() + 'button-usage', { headers: authHeaders() }); };
    var res = await request();
    if(res.status===401){
      if(await tryRefresh()){ res = await request(); }
      if(res.status===401){ host.innerHTML='<div class="error">登录已过期</div>'; return; }
    }
    if(res.status===403){ host.innerHTML='<div class="error">仅管理员可查看</div>'; return; }
    if(!res.ok){ throw new Error('HTTP '+res.status); }
    var d = await res.json();
    LAST_BUTTON_USAGE = d;
    var esc2 = esc;
    var html = '';
    var table = function(title, rows){
      var body = (rows||[]).map(function(r,i){
        return '<tr><td>'+(i+1)+'</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc2(r.buttonId)+'">'+esc2(r.label)+'</td><td>'+r.count+'</td><td>'+r.users+'</td><td>'+fmtDate(r.lastSeenAt)+'</td></tr>';
      }).join('');
      if(!body) return '<div style="color:var(--muted);font-size:12px;margin:6px 0 12px">'+title+'：暂无数据</div>';
      return '<div style="font-size:12px;color:var(--muted);margin:8px 0 4px">'+title+'</div>'+
        '<table><thead><tr><th>#</th><th>按钮</th><th>次数</th><th>人数</th><th>最近使用</th></tr></thead><tbody>'+body+'</tbody></table>';
    };
    html += table('近 7 天排行', d.top7d);
    html += table('近 30 天排行', d.top30d);
    if(d.dailyTrend && d.dailyTrend.length){
      var maxC = Math.max.apply(null, d.dailyTrend.map(function(x){return x.count;}).concat([1]));
      var bars = d.dailyTrend.map(function(x){
        var h = Math.round((x.count/maxC)*46)+2;
        return '<div style="display:inline-block;vertical-align:bottom;margin-right:2px;text-align:center"><div style="width:10px;height:'+h+'px;background:linear-gradient(180deg,var(--accent),var(--accent2));border-radius:2px 2px 0 0" title="'+x.date+'：'+x.count+'"></div></div>';
      }).join('');
      html += '<div style="font-size:12px;color:var(--muted);margin:8px 0 4px">近 30 天按日点击合计</div><div style="display:flex;align-items:flex-end;height:52px">'+bars+'</div>';
    }
    if(d.inventoryCount>0){
      html += '<div style="font-size:12px;color:var(--muted);margin:8px 0 4px">零使用清单（基线 '+d.inventoryCount+' 个按钮，近 30 天零点击）</div>';
      if(d.unused && d.unused.length){
        html += '<div style="font-size:12px;line-height:1.9">'+d.unused.map(function(u){return '<span style="display:inline-block;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:10px;padding:1px 8px;margin:2px">'+esc2(u)+'</span>';}).join('')+'</div>';
      } else {
        html += '<div style="color:var(--muted);font-size:12px">近 30 天基线内按钮均有点击</div>';
      }
    }
    host.innerHTML = html;
  }catch(err){
    host.innerHTML = '<div class="error">按钮统计加载失败：'+esc(err && err.message ? err.message : err)+'</div>';
  }
}
document.getElementById('refreshBtn').addEventListener('click', load);
document.getElementById('daysSel').addEventListener('change', function(){
  // 切到「自定义区间」只展开日期输入，选好点「应用」再查询；其余模式立即重载
  document.getElementById('customRangeBox').style.display = this.value==='custom' ? 'inline' : 'none';
  if(this.value!=='custom'){ load(); }
});
document.getElementById('applyRangeBtn').addEventListener('click', function(){
  var s=document.getElementById('rangeStart').value;
  var e=document.getElementById('rangeEnd').value;
  if(!s||!e){ alert('请选择起始与结束日期'); return; }
  if(s>e){ alert('起始日期不能晚于结束日期'); return; }
  load();
});
// 导出 Excel：后端 /export 按当前查询区间聚合生成 .xlsx（管理员门禁同 overview，
// 含按钮统计 sheet——其口径固定近 7/30 天，不随区间变化）
document.getElementById('exportXlsxBtn').addEventListener('click', function(){
  var btn=this;
  if(!LAST_OVERVIEW || !LAST_EXPORT_QS){ alert('数据尚未加载，请先查询'); return; }
  btn.disabled=true;
  btn.textContent='导出中…';
  var request=function(){ return fetch(basePath() + LAST_EXPORT_QS, { headers: authHeaders() }); };
  request().then(function(res){
    if(res.status===401){ return tryRefresh().then(function(ok){ return ok ? request() : res; }); }
    return res;
  }).then(function(res){
    if(res.status===401){ throw new Error('登录已过期，请重新登录'); }
    if(res.status===403){ throw new Error('仅管理员可导出'); }
    if(!res.ok){ throw new Error('HTTP '+res.status); }
    return res.blob();
  }).then(function(blob){
    var a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=('数据看板-'+CURRENT_RANGE_LABEL+'.xlsx').replace(/[\\/:*?"<>|]/g,'-');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); },3000);
    btn.disabled=false;
    btn.textContent='导出Excel';
  }).catch(function(e){
    btn.disabled=false;
    btn.textContent='导出Excel';
    alert('导出失败：'+(e&&e.message?e.message:e));
  });
});
document.getElementById('copyReportBtn').addEventListener('click', function(){
  var btn=this;
  var text = LAST_OVERVIEW ? buildReportText(LAST_OVERVIEW, CURRENT_RANGE_LABEL) : '';
  if(!text){ alert('报告数据尚未加载'); return; }
  var done=function(){
    btn.textContent='已复制';
    setTimeout(function(){ btn.textContent='复制报告'; },1500);
  };
  // 临时 textarea 兼容 http 环境的复制
  var ta=document.createElement('textarea');
  ta.value=text;
  ta.style.position='fixed';
  ta.style.opacity='0';
  document.body.appendChild(ta);
  ta.select();
  var ok=false;
  try{ ok=document.execCommand('copy'); }catch(e){ ok=false; }
  ta.remove();
  if(ok){ done(); return; }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done,function(){ alert('复制失败，请手动选择文本复制'); });
    return;
  }
  alert('复制失败，请手动选择文本复制');
});

// 整页栅格化：DOM 序列化进 SVG foreignObject 再经 canvas 采样（禁用动画保证终态）
function buildExportCanvas(scale){
  // 以内容区宽度为画布宽度，避免导出图两侧出现大黑边
  var wrapEl = document.querySelector('.wrap');
  var w = wrapEl ? Math.ceil(wrapEl.getBoundingClientRect().width) : Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
  var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  var clone = document.documentElement.cloneNode(true);
  clone.style.width = w + 'px';
  var hdr = clone.querySelector('header');
  if (hdr) { hdr.style.width = w + 'px'; hdr.style.position = 'static'; }
  var cb = clone.querySelector('body');
  if (cb) { cb.style.width = w + 'px'; }
  // 禁用动画/过渡：栅格化时动画停在 t=0 会让带渐入动画的面板不可见
  var fixStyle = document.createElement('style');
  fixStyle.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;backdrop-filter:none!important}';
  var headEl = clone.querySelector('head');
  (headEl || clone).appendChild(fixStyle);
  var ceb = clone.querySelector('#exportBtn');
  if (ceb) { ceb.textContent = '导出图片'; }
  var cxb = clone.querySelector('#exportXlsxBtn');
  if (cxb) { cxb.textContent = '导出Excel'; }
  var cpb = clone.querySelector('#copyReportBtn');
  if (cpb) { cpb.textContent = '复制报告'; }
  var psh = clone.querySelector('#pushBtn');
  if (psh) { psh.textContent = '推送'; }
  var htmlString = new XMLSerializer().serializeToString(clone);
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+
    '<foreignObject width="100%" height="100%">'+htmlString+'</foreignObject></svg>';
  var img = new Image();
  return new Promise(function(resolve, reject){
    img.onload = function(){
      var canvas = document.createElement('canvas');
      canvas.width = w*scale;
      canvas.height = h*scale;
      var ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = function(){ reject(new Error('页面渲染为图片时出错')); };
    img.src = 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  });
}

// 导出图片：整页栅格化为 PNG 下载（零依赖）
document.getElementById('exportBtn').addEventListener('click', function(){
  var btn = this;
  btn.disabled = true;
  btn.textContent = '导出中…';
  buildExportCanvas(2).then(function(canvas){
    var a = document.createElement('a');
    var ts = new Date();
    var p=function(x){return String(x).padStart(2,'0');};
    a.download = '数据看板-'+ts.getFullYear()+p(ts.getMonth()+1)+p(ts.getDate())+'-'+p(ts.getHours())+p(ts.getMinutes())+'.png';
    a.href = canvas.toDataURL('image/png');
    document.body.appendChild(a);
    a.click();
    a.remove();
    btn.disabled = false;
    btn.textContent = '导出图片';
  }).catch(function(e){
    btn.disabled = false;
    btn.textContent = '导出图片';
    alert('导出失败：'+(e && e.message ? e.message : e));
  });
});

// 推送：看板截图上传 Gitee 中转，连同周报文字经钉钉机器人发送
document.getElementById('pushBtn').addEventListener('click', function(){
  var btn = this;
  btn.disabled = true;
  btn.textContent = '推送中…';
  (async function(){
    if(!LAST_OVERVIEW) throw new Error('数据尚未加载');
    var text = buildReportText(LAST_OVERVIEW, CURRENT_RANGE_LABEL);
    var canvas = await buildExportCanvas(2);
    var dataUrl = canvas.toDataURL('image/png');
    // Gitee 单文件上限 1MB，超限改用 1 倍采样
    if(dataUrl.length > 1200000){
      canvas = await buildExportCanvas(1);
      dataUrl = canvas.toDataURL('image/png');
    }
    var res = await fetch(basePath() + 'push-report', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ imageBase64: dataUrl, text: text })
    });
    var j = await res.json();
    if(res.status===403) throw new Error('仅管理员可推送报告');
    if(!(j && j.ok)) throw new Error((j && j.error) || ('HTTP ' + res.status));
  })().then(function(){
    btn.disabled = false;
    btn.textContent = '已推送';
    setTimeout(function(){ btn.textContent = '推送'; }, 2000);
  }).catch(function(e){
    btn.disabled = false;
    btn.textContent = '推送';
    alert('推送失败：'+(e && e.message ? e.message : e));
  });
});

// 推送测试：走完整周报链路（截图+Gitee 图床），但目标为 DEV_DINGTALK_WEBHOOK（开发群，
// 强制 DEV_DINGTALK_SECRET 加签）。按约定页面不回显结果——是否收到以开发群实际消息为准。
document.getElementById('pushTestBtn').addEventListener('click', function(){
  var btn = this;
  btn.disabled = true;
  btn.textContent = '推送中…';
  (async function(){
    if(!LAST_OVERVIEW) throw new Error('数据尚未加载');
    var text = buildReportText(LAST_OVERVIEW, CURRENT_RANGE_LABEL);
    var canvas = await buildExportCanvas(2);
    var dataUrl = canvas.toDataURL('image/png');
    // Gitee 单文件上限 1MB，超限改用 1 倍采样
    if(dataUrl.length > 1200000){
      canvas = await buildExportCanvas(1);
      dataUrl = canvas.toDataURL('image/png');
    }
    var res = await fetch(basePath() + 'push-test', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ imageBase64: dataUrl, text: text })
    });
    var j = await res.json().catch(function(){ return null; });
    if(!(j && j.ok)){
      // 不回显约定：失败只落控制台（配置缺失/钉钉拒绝等原因查函数日志与控制台）
      console.warn('[dashboard-stats] 推送测试未成功:', j && j.error ? j.error : ('HTTP ' + res.status));
    }
  })().then(function(){
    btn.disabled = false;
    btn.textContent = '已触发';
    setTimeout(function(){ btn.textContent = '推送测试'; }, 2000);
  }).catch(function(e){
    btn.disabled = false;
    btn.textContent = '推送测试';
    console.warn('[dashboard-stats] 推送测试请求失败:', e && e.message ? e.message : e);
  });
});

// 登录/退出事件
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPassword').addEventListener('keydown', function(e){ if(e.key==='Enter') doLogin(); });
document.getElementById('loginAccount').addEventListener('keydown', function(e){ if(e.key==='Enter') document.getElementById('loginPassword').focus(); });
document.getElementById('logoutBtn').addEventListener('click', function(){ clearSession(); showLogin(); });

// 启动：填充月份快选；有会话直接加载，否则进入登录页
populateMonthOptions();
loadSession();
if(session){ load(); } else { showLogin(); }
</script>
</div>
</body>
</html>`;
}

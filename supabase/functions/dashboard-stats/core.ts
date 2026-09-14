/**
 * dashboard-stats Edge Function core logic (no Deno dependency, unit-testable)
 *
 * 数据看板聚合逻辑：
 * - 使用 service_role 身份经 PostgREST /storage/v1 REST 直查（绕过 RLS）
 * - 三类统计：任务（task_submissions）、用量（generation_usage）、
 *   用户与组织（user_profiles/staff_directory/departments）、
 *   文件与存储（file_paths/response_file_paths + huabu bucket 对象）
 * - 自包含 HTML 看板页面生成（内联 CSS/JS，无外部依赖）
 *
 * 鉴权：暂不做（本函数不校验调用者身份；页面内嵌 anon key 供 Kong 放行）。
 * 升级路径：后续在函数内加管理员判定，或由 Kong 做网络/IP 限制。
 */

/** anon key（公钥）兜底：与 apps/web/src/supabase/supabase-client.ts 默认值一致 */
export const DEFAULT_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE';

/** 看板函数需要的环境注入（由 index.ts 从 Deno.env 读取传入） */
export interface DashboardEnv {
  SUPABASE_URL: string;
  SERVICE_ROLE_KEY: string;
  /** 可选：页面 JS 调 overview 时 Kong 放行用的公钥；缺省 DEFAULT_ANON_KEY */
  ANON_KEY?: string;
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
        data?: { items?: Array<{ quota?: unknown; username?: unknown }> };
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
      }
      if (items.length < PAGE_SIZE) {
        break;
      }
    }
    return { totalUsd: sum / NEWAPI_QUOTA_PER_UNIT, quotaByUsername };
  } catch {
    return null;
  }
}

/** 聚合的最终返回结构 */
export interface DashboardOverview {
  generatedAt: string;
  days: number;
  /** 美元→人民币展示汇率（configs 表 USD_CNY_RATE，缺省 0.1） */
  usdCnyRate: number;
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

/** 任务参与统计：使用次数排行（按用户前 10）、部门/区域使用情况与部门消耗金额 */
export function aggregateTaskParticipation(
  rows: TaskRow[],
  profileRows: ProfileRow[],
  nameByOa: Map<string, string>,
  nameByUser: Map<string, string>,
  priceByModel: Map<string, number> = new Map()
): Pick<DashboardOverview['tasks'], 'topUsers'> & {
  usageByDepartment: Record<string, number>;
  usageByRegion: Record<string, number>;
  costByDepartment: Record<string, number>;
} {
  const okRows = rows.filter((row) => row.status === 'completed');
  const deptByUser = new Map(profileRows.map((p) => [p.user_id, p.department]));
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

  const topUsers = Array.from(countByUser.entries())
    .map(([userId, count]) => {
      const oaAccount = oaByUser.get(userId) ?? null;
      return {
        userId,
        displayName: resolveDisplayName(userId, oaAccount, nameByUser, nameByOa),
        department: deptByUser.get(userId) ?? null,
        count,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return { topUsers, usageByDepartment, usageByRegion, costByDepartment };
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
    byDepartment: countOccurrences(profileRows, 'department'),
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

  // 并行拉取基础数据
  const [taskResult, usageResult, profileResult, staffResult, deptResult, nameByUser, priceByModel, canvasUsage] =
    await Promise.all([
      restGet(
        env,
        `/rest/v1/task_submissions?select=id,user_id,type,status,created_at,completed_at,file_paths,response_file_paths,model:params-%3E%3Emodel&created_at=gte.${taskFrom}${taskTo ? `&created_at=lt.${taskTo}` : ''}&order=created_at.asc&limit=50000`,
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
  // 部门金额无法从网关日志区分到人，保留按模型价目的估算口径
  let totalCostUsd: number | null = null;
  const costByDepartment = participation.costByDepartment;
  if (canvasUsage) {
    totalCostUsd = Math.round(canvasUsage.totalUsd * 100) / 100;
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

  return {
    generatedAt: new Date().toISOString(),
    days: safeDays,
    usdCnyRate,
    tasks: {
      ...tasksAgg,
      topUsers: participation.topUsers,
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
  };
}

// ============================================================================
// HTML 看板页面（自包含，无外部依赖）
// ============================================================================

/**
 * 生成自包含 HTML 看板页面。页面 JS 以相对路径调 `/overview?days=N`，
 * 请求头带 `Authorization: Bearer <anonKey>`（公钥，供 Kong 放行）。
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
  button, select { background:rgba(148,163,184,.1); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 12px; font-size:13px; cursor:pointer; transition:.15s; }
  button:hover, select:hover { border-color:var(--accent); background:rgba(91,140,255,.12); }
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
    </select>
    <button id="refreshBtn">刷新</button>
    <button id="exportBtn">导出图片</button>
  </div>
</header>
<div class="wrap">

<div class="cards" id="kpiCards"><div class="sk"></div></div>

<div class="grid">
  <div class="panel"><h2>每周使用报告<span class="muted" id="reportRange" style="margin-left:8px;font-weight:400"></span><button id="copyReportBtn" style="margin-left:auto">复制报告</button></h2><textarea id="reportText" readonly style="width:100%;min-height:150px;background:var(--card2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:10px;font-family:inherit;font-size:12px;line-height:1.7"></textarea></div>
</div>

<div class="grid">
  <div class="panel"><h2>操作类型分布</h2><div id="typeDonut"><div class="sk"></div></div></div>
  <div class="panel"><h2>模型使用分布</h2><div id="modelDonut"><div class="sk"></div></div></div>
  <div class="panel"><h2>使用次数排行（前 10）</h2><div id="rankChips"><div class="sk"></div></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>日历使用热力（当月）</h2><div id="calendarHeat"><div class="sk"></div></div></div>
  <div class="panel"><h2>24小时使用分布</h2><div id="hourlyChart"><div class="sk"></div></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>每日成功任务趋势（近 <span id="trendDays"></span> 天）</h2><svg id="trendChart" viewBox="0 0 680 220"></svg></div>
  <div class="panel"><h2>月度用量 Top 用户（当前周期）</h2><table id="topUsers"><thead><tr><th>用户</th><th>部门</th><th>用量</th></tr></thead><tbody></tbody></table></div>
</div>
<div class="grid">
  <div class="panel"><h2>部门使用排行</h2><div id="rankTable"><div class="sk"></div></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>部门使用汇总</h2><table id="deptSummary"><thead><tr><th>部门</th><th>用户数</th><th>使用次数</th><th>金额</th><th>占比</th></tr></thead><tbody></tbody></table></div>
  <div class="panel"><h2>月度用量趋势</h2><div id="usageTrend"><div class="sk"></div></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>部门分布</h2><div id="byDept"><div class="sk"></div></div></div>
</div>
</div>

<script>
var ANON_KEY = "${safeKey}";
var days = 30;

function fmtDate(iso){ if(!iso) return '-'; var d=new Date(iso); if(isNaN(d)) return iso; var p=function(x){return String(x).padStart(2,'0')}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
function fmtBytes(n){ if(n==null) return '-'; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KB'; if(n<1073741824) return (n/1048576).toFixed(1)+' MB'; return (n/1073741824).toFixed(2)+' GB'; }
function esc(s){ return String(s==null?'-':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function fmtDur(ms){ if(!ms) return '-'; var s=ms/1000; if(s<60) return Math.round(s)+' 秒'; if(s<3600) return (s/60).toFixed(1)+' 分钟'; return (s/3600).toFixed(1)+' 小时'; }

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
    ['消耗金额', costVal, costSub, ''],
    ['活跃用户数', t.activeUsers, '', ''],
    ['本月用量', q.latestUsed, '周期 '+(q.latestPeriod||'-'), ''],
    ['数据覆盖天数', o.days, '截至 '+fmtDate(o.generatedAt).slice(0,10), ''],
  ];
  document.getElementById('kpiCards').innerHTML = big.map(function(c){
    return '<div class="card"><div class="label">'+esc(c[0])+'</div><div class="value" style="font-size:30px">'+esc(c[1])+'</div><div class="sub">'+esc(c[2])+'</div>'+(c[3]||'')+'</div>';
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
  var t=o.tasks, u=o.users;
  var cost=(t.totalCostUsd==null)?'—':'¥'+(t.totalCostUsd*USD_CNY).toFixed(2);
  var lines=[];
  lines.push('【YUE 画布使用周报】');
  lines.push('统计周期：'+rangeLabel);
  lines.push('1. 总操作次数：'+t.total+' 次（日均 '+(t.total/Math.max(1,o.days)).toFixed(1)+' 次），活跃用户 '+t.activeUsers+' 人');
  lines.push('2. 消耗金额：'+cost+'（按内部结算汇率折算）');
  var top=(t.topUsers||[]).slice(0,3).map(function(r){return (r.displayName||'-')+' '+r.count+' 次';}).join('、');
  lines.push('3. 使用排行前 3：'+(top||'—'));
  var ms=Object.entries(t.byModel||{}).sort(function(a,b){return b[1]-a[1];}).slice(0,2).map(function(e){return e[0]+' '+e[1]+' 次';}).join('、');
  lines.push('4. 热门模型：'+(ms||'—'));
  var ds=Object.entries(u.usageByRegion||{}).sort(function(a,b){return b[1]-a[1];}).slice(0,3).map(function(e){return e[0]+' '+e[1]+' 次';}).join('、');
  lines.push('5. 各部门使用：'+(ds||'—'));
  return lines.join('\\n');
}

function render(o){
  LAST_OVERVIEW = o;
  var rate = Number(o.usdCnyRate);
  if(Number.isFinite(rate) && rate>0) USD_CNY = rate;
  document.getElementById('generatedAt').textContent = '统计周期 '+CURRENT_RANGE_LABEL+' · 生成于 ' + fmtDate(o.generatedAt);
  document.getElementById('reportRange').textContent = CURRENT_RANGE_LABEL;
  document.getElementById('reportText').value = buildReportText(o, CURRENT_RANGE_LABEL);
  kpiCards(o);
  donut(document.getElementById('typeDonut'), o.tasks.byType);
  donut(document.getElementById('modelDonut'), o.tasks.byModel);
  rankChips(document.getElementById('rankChips'), o.tasks.topUsers);
  calendarHeat(document.getElementById('calendarHeat'), o.tasks.dailyTrend);
  hourlyBars(document.getElementById('hourlyChart'), o.tasks.hourly);
  document.getElementById('trendDays').textContent = o.days;
  trendLine(document.getElementById('trendChart'), o.tasks.dailyTrend);
  document.getElementById('topUsers').querySelector('tbody').innerHTML =
    (o.usage.topUsers||[]).map(function(r){
      return '<tr><td>'+esc(r.displayName || r.oaAccount)+'</td><td>'+esc(r.department)+'</td><td>'+r.used+'</td></tr>';
    }).join('') || '<tr><td colspan="3" class="muted">暂无数据</td></tr>';
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
}

function basePath(){
  var p = location.pathname.replace(/\\/+$/, '');
  p = p.replace(/\\/index\\.html$/, '');
  return p + '/';
}

var CURRENT_RANGE_LABEL = '';

function weekRange(){
  var now=new Date();
  var dow=(now.getDay()+6)%7; // 周一=0
  var mon=new Date(now.getFullYear(),now.getMonth(),now.getDate()-7-dow); // 上周一（完整周期）
  var sun=new Date(mon.getFullYear(),mon.getMonth(),mon.getDate()+6);
  var p=function(x){return String(x).padStart(2,'0');};
  var f=function(d){return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());};
  return {start:f(mon),end:f(sun),label:f(mon)+' ~ '+f(sun)};
}

function load(){
  var mode = document.getElementById('daysSel').value;
  var qs;
  if(mode==='week'){
    var r=weekRange();
    CURRENT_RANGE_LABEL=r.label+'（周一~周日）';
    days=7;
    qs='overview?start='+r.start+'&end='+r.end+'&days=7';
  } else {
    days=Number(mode)||30;
    CURRENT_RANGE_LABEL='近 '+days+' 天';
    qs='overview?days='+days;
  }
  fetch(basePath() + qs, {
    headers: { 'Authorization': 'Bearer ' + ANON_KEY }
  })
    .then(function(res){ if(!res.ok){ throw new Error('HTTP ' + res.status); } return res.json(); })
    .then(render)
    .catch(function(err){
      document.getElementById('kpiCards').innerHTML =
        '<div class="card" style="grid-column:1/-1"><div class="error">加载失败：'+esc(err.message)+'</div></div>';
    });
}

document.getElementById('refreshBtn').addEventListener('click', load);
document.getElementById('daysSel').addEventListener('change', load);
document.getElementById('copyReportBtn').addEventListener('click', function(){
  var ta=document.getElementById('reportText');
  ta.select();
  var ok=false;
  try{ ok=document.execCommand('copy'); }catch(e){ ok=false; }
  if(!ok && navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(ta.value).then(done,function(){});
    return;
  }
  function done(){
    var b=document.getElementById('copyReportBtn');
    b.textContent='已复制';
    setTimeout(function(){ b.textContent='复制报告'; },1500);
  }
  if(ok) done();
});

// 导出图片：整页 DOM 序列化进 SVG foreignObject，栅格化为 PNG 下载（零依赖）
document.getElementById('exportBtn').addEventListener('click', function(){
  var btn = this;
  btn.disabled = true;
  var oldText = btn.textContent;
  btn.textContent = '导出中…';
  try{
    var w = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
    var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    var clone = document.documentElement.cloneNode(true);
    clone.style.width = w + 'px';
    var cb = clone.querySelector('body');
    if (cb) { cb.style.width = w + 'px'; }
    // 禁用动画/过渡：栅格化时动画停在 t=0 会让带渐入动画的面板不可见
    var fixStyle = document.createElement('style');
    fixStyle.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;backdrop-filter:none!important}';
    var headEl = clone.querySelector('head');
    (headEl || clone).appendChild(fixStyle);
    var ceb = clone.querySelector('#exportBtn');
    if (ceb) { ceb.textContent = '导出图片'; }
    var htmlString = new XMLSerializer().serializeToString(clone);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+
      '<foreignObject width="100%" height="100%">'+htmlString+'</foreignObject></svg>';
    var img = new Image();
    img.onload = function(){
      try{
        var scale = 2;
        var canvas = document.createElement('canvas');
        canvas.width = w*scale;
        canvas.height = h*scale;
        var ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        var a = document.createElement('a');
        var ts = new Date();
        var p=function(x){return String(x).padStart(2,'0');};
        a.download = '数据看板-'+ts.getFullYear()+p(ts.getMonth()+1)+p(ts.getDate())+'-'+p(ts.getHours())+p(ts.getMinutes())+'.png';
        a.href = canvas.toDataURL('image/png');
        document.body.appendChild(a);
        a.click();
        a.remove();
        btn.disabled = false;
        btn.textContent = oldText;
      }catch(e){
        btn.disabled = false;
        btn.textContent = oldText;
        alert('导出失败：'+(e && e.message ? e.message : e));
      }
    };
    img.onerror = function(){
      btn.disabled = false;
      btn.textContent = oldText;
      alert('导出失败：页面渲染为图片时出错');
    };
    img.src = 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  }catch(e){
    btn.disabled = false;
    btn.textContent = oldText;
    alert('导出失败：'+(e && e.message ? e.message : e));
  }
});

load();
</script>
</div>
</body>
</html>`;
}

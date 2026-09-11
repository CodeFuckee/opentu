/**
 * dashboard-stats Edge Function core logic (no Deno dependency, unit-testable)
 *
 * 数据看板聚合逻辑：
 * - 使用 service_role 身份经 PostgREST /storage/v1 REST 直查（绕过 RLS）
 * - 四类统计：任务（task_submissions）、用量（generation_usage）、
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

/** GoTrue admin users 响应（/auth/v1/admin/users） */
interface AuthUsersResponse {
  users?: Array<{
    id?: unknown;
    user_metadata?: { displayName?: unknown; full_name?: unknown; name?: unknown };
  }>;
  next_page?: unknown;
}

/** 四类聚合的最终返回结构 */
export interface DashboardOverview {
  generatedAt: string;
  days: number;
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
    recent: Array<{
      oaAccount: string | null;
      displayName: string | null;
      createdAt: string;
    }>;
    staffDirectory: number;
    enabledDepartments: number;
  };
  storage: {
    inputFiles: number;
    outputFiles: number;
    bucket: { objects: number; bytes: number } | null;
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

/** 任务参与统计：使用次数排行（按用户前 10）与部门使用情况 */
export function aggregateTaskParticipation(
  rows: TaskRow[],
  profileRows: ProfileRow[],
  nameByOa: Map<string, string>,
  nameByUser: Map<string, string>
): Pick<DashboardOverview['tasks'], 'topUsers'> & {
  usageByDepartment: Record<string, number>;
} {
  const okRows = rows.filter((row) => row.status === 'completed');
  const deptByUser = new Map(profileRows.map((p) => [p.user_id, p.department]));
  const oaByUser = new Map(profileRows.map((p) => [p.user_id, p.oa_account]));

  const countByUser = new Map<string, number>();
  const usageByDepartment: Record<string, number> = {};
  for (const row of okRows) {
    const userId = row.user_id || '';
    if (!userId) {
      continue;
    }
    countByUser.set(userId, (countByUser.get(userId) ?? 0) + 1);
    const dept = deptByUser.get(userId) || '未知部门';
    usageByDepartment[dept] = (usageByDepartment[dept] ?? 0) + 1;
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

  return { topUsers, usageByDepartment };
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
  departmentRows: DepartmentRow[],
  nameByOa: Map<string, string> = new Map(),
  nameByUser: Map<string, string> = new Map()
): DashboardOverview['users'] {
  const recent = [...profileRows]
    .sort(
      (a, b) =>
        new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    )
    .slice(0, 10)
    .map((row) => ({
      oaAccount: row.oa_account ?? null,
      displayName: resolveDisplayName(
        row.user_id ?? null,
        row.oa_account ?? null,
        nameByUser,
        nameByOa
      ),
      createdAt: row.created_at,
    }));

  return {
    total: profileRows.length,
    byDepartment: countOccurrences(profileRows, 'department'),
    byRegion: countOccurrences(profileRows, 'region'),
    recent,
    staffDirectory: staffDirectoryTotal,
    enabledDepartments: departmentRows.filter((d) => d.enabled).length,
  };
}

/** 文件计数：file_paths / response_file_paths 的 jsonb 数组长度求和 */
export function countTaskFiles(rows: TaskRow[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const row of rows) {
    input += arrayLength(row.file_paths);
    output += arrayLength(row.response_file_paths);
  }
  return { input, output };
}

/**
 * huabu bucket 对象数与总大小（service_role 调 storage 对象列表，分页统计）。
 * 失败时返回 null（页面降级只显示文件计数）。
 */
export async function fetchBucketStats(
  env: DashboardEnv,
  deps: DashboardDeps
): Promise<{ objects: number; bytes: number } | null> {
  const doFetch = deps.fetch || fetch;
  const url = `${baseUrl(env)}/storage/v1/object/list/huabu`;
  const headers = {
    ...srkHeaders(env),
    'Content-Type': 'application/json',
  };

  let objects = 0;
  let bytes = 0;
  const PAGE_LIMIT = 1000;
  const MAX_PAGES = 100;

  try {
    for (let offset = 0, page = 0; page < MAX_PAGES; page += 1) {
      const response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prefix: '', limit: PAGE_LIMIT, offset }),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as unknown;
      const items = Array.isArray(body)
        ? body
        : (body as { error?: unknown }).error
          ? []
          : [];
      if (items.length === 0) {
        break;
      }
      for (const item of items as Array<{
        metadata?: { size?: unknown };
      }>) {
        const size = Number(item?.metadata?.size ?? 0);
        bytes += Number.isFinite(size) ? size : 0;
      }
      objects += items.length;
      offset += items.length;
      if (items.length < PAGE_LIMIT) {
        break;
      }
    }
    return { objects, bytes };
  } catch {
    return null;
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

/** 聚合全量看板数据（days 为任务趋势/过滤窗口天数） */
export async function aggregateOverview(
  env: DashboardEnv,
  days: number,
  deps: DashboardDeps = {}
): Promise<DashboardOverview> {
  const safeDays = clampDays(days);
  const from = dateNDaysAgo(safeDays);

  // 并行拉取基础数据
  const [taskResult, usageResult, profileResult, staffResult, deptResult, nameByUser] =
    await Promise.all([
      restGet(
        env,
        `/rest/v1/task_submissions?select=id,user_id,type,status,created_at,completed_at,file_paths,response_file_paths,model:params-%3E%3Emodel&created_at=gte.${from}&order=created_at.asc&limit=50000`,
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
  const bucket = await fetchBucketStats(env, deps);
  const files = countTaskFiles(taskRows);
  const participation = aggregateTaskParticipation(
    taskRows,
    profileRows,
    nameByOa,
    nameByUser
  );

  return {
    generatedAt: new Date().toISOString(),
    days: safeDays,
    tasks: { ...aggregateTasks(taskRows), topUsers: participation.topUsers },
    usage: aggregateUsage(usageRows, profileRows, quotaLimit, nameByOa, nameByUser),
    users: {
      ...aggregateUsers(
        profileRows,
        staffResult.total ?? staffRows.length,
        departmentRows,
        nameByOa,
        nameByUser
      ),
      usageByDepartment: participation.usageByDepartment,
    },
    storage: {
      inputFiles: files.input,
      outputFiles: files.output,
      bucket,
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
  :root { --bg:#0f1420; --card:#171e2e; --card2:#1d2638; --line:#2a3550; --text:#e6ecf7; --muted:#8b98b3; --accent:#4f8cff; --ok:#34d399; --fail:#f87171; --warn:#fbbf24; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; padding:20px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
  h1 { font-size:20px; font-weight:600; }
  .controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  button, select { background:var(--card2); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font-size:13px; cursor:pointer; }
  button:hover { border-color:var(--accent); }
  .meta { color:var(--muted); font-size:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .label { color:var(--muted); font-size:12px; margin-bottom:6px; }
  .card .value { font-size:24px; font-weight:600; }
  .card .sub { color:var(--muted); font-size:12px; margin-top:4px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:12px; margin-bottom:20px; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .panel h2 { font-size:14px; font-weight:600; margin-bottom:12px; color:var(--text); }
  .bar-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:12px; }
  .bar-row .name { width:110px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--muted); }
  .bar-row .track { flex:1; height:14px; background:var(--card2); border-radius:4px; overflow:hidden; }
  .bar-row .fill { height:100%; background:var(--accent); border-radius:4px; }
  .bar-row .num { width:56px; text-align:right; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; }
  .pill { display:inline-block; padding:1px 8px; border-radius:10px; font-size:11px; background:var(--card2); }
  .pill.ok { color:var(--ok); } .pill.fail { color:var(--fail); } .pill.warn { color:var(--warn); }
  .legend { display:flex; gap:12px; font-size:12px; color:var(--muted); margin-bottom:10px; flex-wrap:wrap; }
  .legend span i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; }
  svg { width:100%; height:auto; display:block; }
  .error { color:var(--fail); padding:20px; text-align:center; }
  .muted { color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>📊 数据看板</h1>
  <div class="controls">
    <span class="meta" id="generatedAt"></span>
    <select id="daysSel">
      <option value="7">近 7 天</option>
      <option value="30" selected>近 30 天</option>
      <option value="90">近 90 天</option>
    </select>
    <button id="refreshBtn">刷新</button>
  </div>
</header>

<div class="cards" id="kpiCards"></div>
<div class="cards" id="subCards"></div>

<div class="grid">
  <div class="panel"><h2>操作类型分布</h2><div id="typeDonut"></div></div>
  <div class="panel"><h2>模型使用分布</h2><div id="modelDonut"></div></div>
  <div class="panel"><h2>使用次数排行（前 10）</h2><div id="rankChips"></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>日历使用热力（当月）</h2><div id="calendarHeat"></div></div>
  <div class="panel"><h2>24小时使用分布</h2><div id="hourlyChart"></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>每日成功任务趋势（近 <span id="trendDays"></span> 天）</h2><svg id="trendChart" viewBox="0 0 680 220"></svg></div>
  <div class="panel"><h2>月度用量 Top 用户（当前周期）</h2><table id="topUsers"><thead><tr><th>用户</th><th>部门</th><th>用量</th></tr></thead><tbody></tbody></table></div>
</div>
<div class="grid">
  <div class="panel"><h2>部门使用情况</h2><div id="deptUsage"></div></div>
  <div class="panel"><h2>区间使用排行 <select id="rankSel" style="margin-left:8px"><option value="dept" selected>部门排行</option><option value="user">用户排行</option></select></h2><div id="rankTable"></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>部门使用汇总</h2><table id="deptSummary"><thead><tr><th>部门</th><th>用户数</th><th>使用次数</th><th>占比</th></tr></thead><tbody></tbody></table></div>
  <div class="panel"><h2>月度用量趋势</h2><div id="usageTrend"></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>区域分布</h2><div id="byRegion"></div></div>
  <div class="panel"><h2>最近注册用户</h2><table id="recentUsers"><thead><tr><th>用户</th><th>注册时间</th></tr></thead><tbody></tbody></table></div>
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
  var W=680, H=200, pad=30;
  if(!points.length){
    svg.innerHTML='<text x="340" y="100" text-anchor="middle" fill="#8b98b3" font-size="13">暂无数据</text>';
    return;
  }
  var max = Math.max.apply(null, points.map(function(p){return p.count;})) || 1;
  var n = points.length;
  var stepX = (W-pad*2)/Math.max(1,n-1);
  var coords = points.map(function(p,i){
    return [pad + i*stepX, H-pad+10 - (p.count/max)*(H-pad*2)];
  });
  var path = coords.map(function(c,i){return (i?'L':'M')+c[0].toFixed(1)+','+c[1].toFixed(1);}).join(' ');
  var area = path + ' L'+(pad+(n-1)*stepX).toFixed(1)+','+(H-pad+10)+' L'+pad+','+(H-pad+10)+' Z';
  svg.innerHTML =
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f8cff" stop-opacity="0.35"/><stop offset="1" stop-color="#4f8cff" stop-opacity="0"/></linearGradient></defs>'+
    '<path d="'+area+'" fill="url(#g)"/>'+
    '<path d="'+path+'" fill="none" stroke="#4f8cff" stroke-width="2"/>'+
    coords.map(function(c){return '<circle cx="'+c[0].toFixed(1)+'" cy="'+c[1].toFixed(1)+'" r="3" fill="#4f8cff"/>';}).join('')+
    '<text x="'+pad+'" y="'+(H-pad+5)+'" fill="#8b98b3" font-size="10">'+esc(points[0].date)+'</text>'+
    '<text x="'+(W-pad)+'" y="'+(H-pad+5)+'" fill="#8b98b3" font-size="10" text-anchor="end">'+esc(points[n-1].date)+'</text>'+
    '<text x="'+pad+'" y="15" fill="#8b98b3" font-size="11">峰值 '+max+'</text>';
}

var CHART_COLORS = ['#4f8cff','#34d399','#fbbf24','#f472b6','#c084fc','#f97316','#22d3ee','#a3e635','#fb7185','#60a5fa'];
var LAST_OVERVIEW = null;

function kpiCards(o){
  var t = o.tasks, u = o.users, s = o.storage, q = o.usage;
  var big = [
    ['总操作次数（近 '+o.days+' 天）', t.total, '日均 '+(t.total/Math.max(1,o.days)).toFixed(1)+' · 平均耗时 '+fmtDur(t.avgDurationMs)],
    ['消耗金额', '-', '暂无计费数据源'],
    ['活跃用户数', t.activeUsers, '用户总数 '+u.total],
    ['数据覆盖天数', o.days, '截至 '+fmtDate(o.generatedAt).slice(0,10)],
  ];
  document.getElementById('kpiCards').innerHTML = big.map(function(c){
    return '<div class="card"><div class="label">'+esc(c[0])+'</div><div class="value" style="font-size:30px">'+esc(c[1])+'</div><div class="sub">'+esc(c[2])+'</div></div>';
  }).join('');
  var sub = [
    ['用户总数', u.total, '花名册 '+u.staffDirectory+' · 可用部门 '+u.enabledDepartments],
    ['本月用量', q.latestUsed + ' / ' + q.quotaLimit, '周期 '+ (q.latestPeriod||'-')],
    ['上传文件', s.inputFiles, 'input-*'],
    ['生成文件', s.outputFiles, 'output-*'],
    ['bucket 对象', s.bucket ? s.bucket.objects : '-', s.bucket ? fmtBytes(s.bucket.bytes) : 'storage 不可用'],
  ];
  document.getElementById('subCards').innerHTML = sub.map(function(c){
    return '<div class="card"><div class="label">'+esc(c[0])+'</div><div class="value">'+esc(c[1])+'</div><div class="sub">'+esc(c[2])+'</div></div>';
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
    stops.push(CHART_COLORS[i%CHART_COLORS.length]+' '+from.toFixed(1)+'deg '+to.toFixed(1)+'deg');
  });
  el.innerHTML = '<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">'+
    '<div style="width:150px;height:150px;border-radius:50%;flex:none;background:conic-gradient('+stops.join(',')+');position:relative">'+
    '<div style="position:absolute;inset:26%;border-radius:50%;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600">'+total+'</div></div>'+
    '<div style="display:flex;flex-direction:column;gap:4px;min-width:150px">'+top.map(function(e,i){
      return '<span class="legend" style="margin:0"><i style="background:'+CHART_COLORS[i%CHART_COLORS.length]+'"></i>'+esc(e[0])+' <b>'+e[1]+'</b>（'+(e[1]/total*100).toFixed(1)+'%）</span>';
    }).join('')+'</div></div>';
}

function rankChips(el, list){
  el.style.display='flex'; el.style.gap='8px'; el.style.flexWrap='wrap';
  el.innerHTML = (list||[]).map(function(r){
    var name = r.displayName || '-';
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 8px;background:var(--card2);border-radius:8px;min-width:66px;flex:1">'+
      '<div style="width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px">'+esc(name.charAt(0))+'</div>'+
      '<div style="font-size:11px;color:var(--muted);max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(name)+'">'+esc(name)+'</div>'+
      '<div style="font-size:14px;font-weight:600;color:var(--accent)">'+r.count+'</div></div>';
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
  html+='</div>'; el.innerHTML=html;
}

function hourlyBars(el, hourly){
  var a = hourly||[]; var max = Math.max.apply(null, a.length?a:[0]) || 1;
  var W=680,H=180,pad=22, bw=(W-pad*2)/24;
  var svg='';
  for(var h=0;h<24;h++){
    var c=a[h]||0; var hgt=c/max*(H-pad*2-10); var x=pad+h*bw;
    svg+='<rect x="'+x.toFixed(1)+'" y="'+(H-pad-Math.max(0,hgt)).toFixed(1)+'" width="'+(bw-3).toFixed(1)+'" height="'+Math.max(0,hgt).toFixed(1)+'" rx="2" fill="#4f8cff"></rect>'+
      '<text x="'+(x+bw/2-1.5).toFixed(1)+'" y="'+(H-6)+'" fill="#8b98b3" font-size="9" text-anchor="middle">'+h+'h</text>';
    if(c>0) svg+='<text x="'+(x+bw/2-1.5).toFixed(1)+'" y="'+(H-pad-hgt-4).toFixed(1)+'" fill="#8b98b3" font-size="9" text-anchor="middle">'+c+'</text>';
  }
  el.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;display:block">'+svg+'</svg>';
}

function deptUsageCards(el, usageByDept, total){
  var entries=Object.entries(usageByDept||{}).sort(function(a,b){return b[1]-a[1];});
  el.innerHTML = entries.map(function(e){
    var pct = total? (e[1]/total*100):0;
    return '<div style="background:var(--card2);border-radius:8px;padding:10px 12px;margin-bottom:8px">'+
      '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px"><span>'+esc(e[0])+'</span><span class="muted">使用次数 '+e[1]+'　'+pct.toFixed(1)+'%</span></div>'+
      '<div style="height:6px;border-radius:3px;background:var(--bg);overflow:hidden"><div style="height:100%;width:'+pct.toFixed(1)+'%;background:var(--accent);border-radius:3px"></div></div></div>';
  }).join('') || '<div class="muted">暂无数据</div>';
}

function rankTable(el, o){
  var mode = document.getElementById('rankSel').value;
  var total = o.tasks.total;
  var rows;
  if(mode==='user'){
    rows = (o.tasks.topUsers||[]).map(function(r){return [r.displayName||'-', r.count];});
  } else {
    rows = Object.entries(o.users.usageByDepartment||{}).sort(function(a,b){return b[1]-a[1];}).slice(0,10);
  }
  el.innerHTML = '<table><thead><tr><th>排名</th><th>名称</th><th>使用次数</th><th>占比</th></tr></thead><tbody>'+
    (rows.length?rows.map(function(r,i){
      return '<tr><td>'+(i+1)+'</td><td>'+esc(r[0])+'</td><td>'+r[1]+'</td><td>'+(total?(r[1]/total*100).toFixed(1)+'%':'-')+'</td></tr>';
    }).join(''):'<tr><td colspan="4" class="muted">暂无数据</td></tr>')+'</tbody></table>';
}

function render(o){
  LAST_OVERVIEW = o;
  document.getElementById('generatedAt').textContent = '生成于 ' + fmtDate(o.generatedAt);
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
  deptUsageCards(document.getElementById('deptUsage'), o.users.usageByDepartment, o.tasks.total);
  rankTable(document.getElementById('rankTable'), o);
  var summaryRows = Object.entries(o.users.usageByDepartment||{}).sort(function(a,b){return b[1]-a[1];});
  var usersByDept = o.users.byDepartment||{};
  var total = o.tasks.total;
  document.getElementById('deptSummary').querySelector('tbody').innerHTML =
    (summaryRows.length?summaryRows.map(function(e){
      return '<tr><td>'+esc(e[0])+'</td><td>'+esc(usersByDept[e[0]]||0)+'</td><td>'+e[1]+'</td><td>'+(total?(e[1]/total*100).toFixed(1)+'%':'-')+'</td></tr>';
    }).join(''):'<tr><td colspan="4" class="muted">暂无数据</td></tr>');
  bars(document.getElementById('byRegion'), o.users.byRegion, '#c084fc');
  bars(document.getElementById('usageTrend'), (o.usage.byPeriod||[]).reduce(function(m,p){m[p.period]=p.used;return m;},{}), '#f472b6');
  document.getElementById('recentUsers').querySelector('tbody').innerHTML =
    (o.users.recent||[]).map(function(r){
      return '<tr><td>'+esc(r.displayName || r.oaAccount)+'</td><td>'+fmtDate(r.createdAt)+'</td></tr>';
    }).join('') || '<tr><td colspan="2" class="muted">暂无数据</td></tr>';
}

function basePath(){
  var p = location.pathname.replace(/\\/+$/, '');
  p = p.replace(/\\/index\\.html$/, '');
  return p + '/';
}

function load(){
  var daysVal = document.getElementById('daysSel').value;
  days = Number(daysVal) || 30;
  fetch(basePath() + 'overview?days=' + days, {
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
document.getElementById('rankSel').addEventListener('change', function(){
  if(LAST_OVERVIEW) rankTable(document.getElementById('rankTable'), LAST_OVERVIEW);
});
load();
</script>
</body>
</html>`;
}

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
  type: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  file_paths?: unknown;
  response_file_paths?: unknown;
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

/** 四类聚合的最终返回结构 */
export interface DashboardOverview {
  generatedAt: string;
  days: number;
  tasks: {
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    successRate: number;
    avgDurationMs: number;
    dailyTrend: Array<{ date: string; count: number }>;
  };
  usage: {
    quotaLimit: number;
    byPeriod: Array<{ period: string; used: number }>;
    latestPeriod: string;
    latestUsed: number;
    topUsers: Array<{
      oaAccount: string | null;
      department: string | null;
      used: number;
    }>;
  };
  users: {
    total: number;
    byDepartment: Record<string, number>;
    byRegion: Record<string, number>;
    recent: Array<{ oaAccount: string | null; createdAt: string }>;
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

/** 任务统计：task_submissions（轻量列 + created_at 日期过滤） */
export function aggregateTasks(rows: TaskRow[]): DashboardOverview['tasks'] {
  const byType = countOccurrences(rows, 'type');
  const byStatus = countOccurrences(rows, 'status');

  const completed = byStatus['completed'] ?? 0;
  const failed = byStatus['failed'] ?? 0;
  const successRate = completed + failed > 0 ? completed / (completed + failed) : 0;

  const trendMap = new Map<string, number>();
  let durationSum = 0;
  let durationCount = 0;
  for (const row of rows) {
    const date = (row.created_at || '').slice(0, 10);
    if (date) {
      trendMap.set(date, (trendMap.get(date) ?? 0) + 1);
    }
    if (
      row.status === 'completed' &&
      typeof row.created_at === 'string' &&
      typeof row.completed_at === 'string'
    ) {
      durationSum +=
        new Date(row.completed_at).getTime() - new Date(row.created_at).getTime();
      durationCount += 1;
    }
  }

  return {
    total: rows.length,
    byType,
    byStatus,
    successRate,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    dailyTrend: Array.from(trendMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** 用量与额度：generation_usage + user_profiles join + 部门配置限额 */
export function aggregateUsage(
  usageRows: UsageRow[],
  profileRows: ProfileRow[],
  quotaLimit: number
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
      return {
        oaAccount: profile?.oa_account ?? null,
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
  const recent = [...profileRows]
    .sort(
      (a, b) =>
        new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    )
    .slice(0, 10)
    .map((row) => ({ oaAccount: row.oa_account ?? null, createdAt: row.created_at }));

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
  const [taskResult, usageResult, profileResult, staffResult, deptResult] =
    await Promise.all([
      restGet(
        env,
        `/rest/v1/task_submissions?select=id,type,status,created_at,completed_at,file_paths,response_file_paths&created_at=gte.${from}&order=created_at.asc&limit=50000`,
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
        `/rest/v1/staff_directory?select=id&limit=1`,
        deps
      ).catch(() => ({ rows: [], total: null })),
      restGet(
        env,
        `/rest/v1/departments?select=name,enabled&limit=1000`,
        deps
      ).catch(() => ({ rows: [], total: null })),
    ]);

  const taskRows = taskResult.rows as TaskRow[];
  const usageRows = usageResult.rows as UsageRow[];
  const profileRows = profileResult.rows as ProfileRow[];
  const departmentRows = deptResult.rows as DepartmentRow[];

  const quotaLimit = await readQuotaLimit(env, deps);
  const bucket = await fetchBucketStats(env, deps);
  const files = countTaskFiles(taskRows);

  return {
    generatedAt: new Date().toISOString(),
    days: safeDays,
    tasks: aggregateTasks(taskRows),
    usage: aggregateUsage(usageRows, profileRows, quotaLimit),
    users: aggregateUsers(profileRows, staffResult.total ?? 0, departmentRows),
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

<div class="grid">
  <div class="panel"><h2>任务量按类型</h2><div id="byType"></div></div>
  <div class="panel"><h2>任务状态分布</h2><div id="byStatus"></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>每日任务趋势（近 <span id="trendDays"></span> 天）</h2><svg id="trendChart" viewBox="0 0 680 220"></svg></div>
  <div class="panel"><h2>月度用量 Top 用户（当前周期）</h2><table id="topUsers"><thead><tr><th>用户</th><th>部门</th><th>用量</th></tr></thead><tbody></tbody></table></div>
</div>
<div class="grid">
  <div class="panel"><h2>部门分布</h2><div id="byDept"></div></div>
  <div class="panel"><h2>区域分布</h2><div id="byRegion"></div></div>
</div>
<div class="grid">
  <div class="panel"><h2>月度用量趋势</h2><div id="usageTrend"></div></div>
  <div class="panel"><h2>最近注册用户</h2><table id="recentUsers"><thead><tr><th>账号</th><th>注册时间</th></tr></thead><tbody></tbody></table></div>
</div>

<script>
var ANON_KEY = "${safeKey}";
var days = 30;

function fmtDate(iso){ if(!iso) return '-'; var d=new Date(iso); if(isNaN(d)) return iso; var p=function(x){return String(x).padStart(2,'0')}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
function fmtBytes(n){ if(n==null) return '-'; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KB'; if(n<1073741824) return (n/1048576).toFixed(1)+' MB'; return (n/1073741824).toFixed(2)+' GB'; }
function esc(s){ return String(s==null?'-':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function pct(n){ return (n*100).toFixed(1)+'%'; }

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

function kpiCards(o){
  var t = o.tasks, u = o.users, s = o.storage, q = o.usage;
  var cards = [
    ['任务总数（近 '+o.days+' 天）', t.total, '成功率 '+pct(t.successRate)],
    ['用户总数', u.total, '花名册 '+u.staffDirectory+' · 可用部门 '+u.enabledDepartments],
    ['本月用量', q.latestUsed + ' / ' + q.quotaLimit, '周期 '+ (q.latestPeriod||'-')],
    ['上传文件', s.inputFiles, 'input-*'],
    ['生成文件', s.outputFiles, 'output-*'],
    ['bucket 对象', s.bucket ? s.bucket.objects : '-', s.bucket ? fmtBytes(s.bucket.bytes) : 'storage 不可用'],
  ];
  document.getElementById('kpiCards').innerHTML = cards.map(function(c){
    return '<div class="card"><div class="label">'+esc(c[0])+'</div><div class="value">'+esc(c[1])+'</div><div class="sub">'+esc(c[2])+'</div></div>';
  }).join('');
}

function render(o){
  document.getElementById('generatedAt').textContent = '生成于 ' + fmtDate(o.generatedAt);
  kpiCards(o);
  bars(document.getElementById('byType'), o.tasks.byType, '#4f8cff');
  bars(document.getElementById('byStatus'), o.tasks.byStatus, '#34d399');
  document.getElementById('trendDays').textContent = o.days;
  trendLine(document.getElementById('trendChart'), o.tasks.dailyTrend);
  document.getElementById('topUsers').querySelector('tbody').innerHTML =
    (o.usage.topUsers||[]).map(function(r){
      return '<tr><td>'+esc(r.oaAccount)+'</td><td>'+esc(r.department)+'</td><td>'+r.used+'</td></tr>';
    }).join('') || '<tr><td colspan="3" class="muted">暂无数据</td></tr>';
  bars(document.getElementById('byDept'), o.users.byDepartment, '#fbbf24');
  bars(document.getElementById('byRegion'), o.users.byRegion, '#c084fc');
  bars(document.getElementById('usageTrend'), (o.usage.byPeriod||[]).reduce(function(m,p){m[p.period]=p.used;return m;},{}), '#f472b6');
  document.getElementById('recentUsers').querySelector('tbody').innerHTML =
    (o.users.recent||[]).map(function(r){
      return '<tr><td>'+esc(r.oaAccount)+'</td><td>'+fmtDate(r.createdAt)+'</td></tr>';
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
load();
</script>
</body>
</html>`;
}

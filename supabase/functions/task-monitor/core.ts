/**
 * task-monitor Edge Function core logic (no Deno dependency, unit-testable)
 *
 * 监控 task_submissions 表中的生图任务，回答一个问题：
 * 「超过 60 秒的生图任务现在是否还会被 edge-runtime 杀死？」
 *
 * 判定依据（2026-09-15 修复后加入）：
 * - 被杀特征：任务 error.message 为兜底文案，且 upstream_response 含
 *   "WorkerRequestCancelled"（main worker catch 返回的 500 body）
 * - 修复生效的正面证据：存在 duration > 60s 且 completed 的任务
 *
 * index.ts 只负责 Deno.serve / 环境变量注入；本文件持有参数校验、
 * PostgREST 查询与聚合逻辑。
 */

/** 修复部署的大致时间（UTC）：workerTimeoutMs 60s→15min + Envoy 路由放宽 */
export const FIX_DEPLOYED_AT = '2026-09-15T03:45:00Z';

/** 默认统计窗口（小时） */
export const DEFAULT_WINDOW_HOURS = 24;
/** 窗口上限（小时），防止一次拉取过多行 */
export const MAX_WINDOW_HOURS = 168;
/** 失败明细返回条数上限 */
export const RECENT_FAILURES_LIMIT = 10;
/** completed 长任务样例返回条数上限 */
export const LONG_TASK_SAMPLES_LIMIT = 5;
/** 单次 PostgREST 查询行数上限 */
const MAX_ROWS = 2000;

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};

export interface TaskMonitorDeps {
  /** Injected HTTP client for testing; defaults to global fetch */
  fetch?: typeof fetch;
}

export interface TaskMonitorEnv {
  SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
}

/** PostgREST 拉回的行（失败切片，含错误信息） */
export interface FailedTaskRow {
  task_id: string;
  created_at: string;
  completed_at: string | null;
  error?: unknown;
  upstream_response?: unknown;
}

/** PostgREST 拉回的行（完成切片，仅时间列） */
export interface CompletedTaskRow {
  task_id: string;
  created_at: string;
  completed_at: string | null;
}

/** 解析窗口小时数：非法/缺省回退 24，上限 168 */
export function parseWindowHours(raw: unknown): number {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_HOURS;
  return Math.min(Math.floor(n), MAX_WINDOW_HOURS);
}

/** 从请求（GET query 或 POST body）中解析窗口小时数 */
export async function readWindowHoursFromRequest(
  request: Request
): Promise<number> {
  if (request.method === 'GET') {
    const hours = new URL(request.url).searchParams.get('hours');
    return parseWindowHours(hours ?? undefined);
  }
  try {
    const body = (await request.json()) as { hours?: unknown };
    return parseWindowHours(body?.hours);
  } catch {
    return parseWindowHours(undefined);
  }
}

export function buildAuthUrl(supabaseUrl: string): string {
  return `${(supabaseUrl || '').replace(/\/$/, '')}/auth/v1/user`;
}

export function buildFailedSliceUrl(
  supabaseUrl: string,
  sinceIso: string
): string {
  const base = `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/task_submissions`;
  const params = new URLSearchParams({
    select: 'task_id,created_at,completed_at,error,upstream_response',
    status: 'eq.failed',
    type: 'eq.image',
    created_at: `gte.${sinceIso}`,
    order: 'created_at.desc',
    limit: String(MAX_ROWS),
  });
  return `${base}?${params.toString()}`;
}

export function buildCompletedSliceUrl(
  supabaseUrl: string,
  sinceIso: string
): string {
  const base = `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/task_submissions`;
  const params = new URLSearchParams({
    select: 'task_id,created_at,completed_at',
    status: 'eq.completed',
    type: 'eq.image',
    created_at: `gte.${sinceIso}`,
    order: 'created_at.desc',
    limit: String(MAX_ROWS),
  });
  return `${base}?${params.toString()}`;
}

/** 校验调用者的 Supabase JWT（GET /auth/v1/user 自证），无效返回 false */
export async function verifyCallerJwt(
  supabaseUrl: string,
  serviceRoleKey: string,
  jwt: string,
  deps: TaskMonitorDeps = {}
): Promise<boolean> {
  const doFetch = deps.fetch || fetch;
  try {
    const response = await doFetch(buildAuthUrl(supabaseUrl), {
      method: 'GET',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${jwt}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 管理员判定：调数据库统一 RPC is_admin()（security definer）。
 * role=user_profiles.role='admin' 优先，configs 历史名单回退，单点维护在 DB 侧；
 * RPC 不可用/失败一律按非管理员处理（fail-closed）。
 */
export async function isAdminCaller(
  supabaseUrl: string,
  serviceRoleKey: string,
  jwt: string,
  deps: TaskMonitorDeps = {}
): Promise<boolean> {
  const doFetch = deps.fetch || fetch;
  try {
    const response = await doFetch(
      `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/rpc/is_admin`,
      {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }
    );
    if (!response.ok) return false;
    return (await response.json().catch(() => false)) === true;
  } catch {
    return false;
  }
}

export function extractBearerToken(headerValue: string | null): string | null {
  const match = (headerValue || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** 从任务 error/upstream_response 中提取可读的错误消息 */
export function extractErrorMessage(row: FailedTaskRow): string | null {
  const err = row.error as { message?: unknown } | null | undefined;
  if (err && typeof err.message === 'string') return err.message;
  return null;
}

/** 是否为 edge-runtime 杀死特征：WorkerRequestCancelled 出现在错误体或上游响应中 */
export function isWorkerCancelledKill(row: FailedTaskRow): boolean {
  const haystacks = [JSON.stringify(row.error ?? ''), JSON.stringify(row.upstream_response ?? '')];
  return haystacks.some((text) => text.includes('WorkerRequestCancelled'));
}

/** 任务时长（秒）；completed_at 缺失时返回 null */
export function durationSeconds(
  createdAt: string,
  completedAt: string | null
): number | null {
  if (!completedAt) return null;
  const start = Date.parse(createdAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

export interface RecentFailure {
  taskId: string;
  createdAt: string;
  completedAt: string | null;
  durationSec: number | null;
  errorMessage: string | null;
  killed: boolean;
}

export interface LongTaskSample {
  taskId: string;
  createdAt: string;
  completedAt: string;
  durationSec: number;
}

export interface MonitorReport {
  windowHours: number;
  since: string;
  fixDeployedAt: string;
  counts: {
    completed: number;
    completedOver60s: number;
    failed: number;
    killedTotal: number;
    killedAfterFix: number;
  };
  maxCompletedDurationSec: number | null;
  longTaskSamples: LongTaskSample[];
  recentFailures: RecentFailure[];
  conclusion: string;
}

/** 纯聚合：由两份切片行计算出监控报告 */
export function aggregate(
  windowHours: number,
  sinceIso: string,
  failedRows: FailedTaskRow[],
  completedRows: CompletedTaskRow[],
  now = Date.now()
): MonitorReport {
  const fixMs = Date.parse(FIX_DEPLOYED_AT);

  const completedDurations = completedRows
    .map((row) => durationSeconds(row.created_at, row.completed_at))
    .filter((d): d is number => d !== null);

  const completedOver60s = completedDurations.filter((d) => d > 60).length;
  const maxCompletedDurationSec =
    completedDurations.length > 0 ? Math.max(...completedDurations) : null;

  const longTaskSamples: LongTaskSample[] = completedRows
    .map((row) => ({
      taskId: row.task_id,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? '',
      durationSec: durationSeconds(row.created_at, row.completed_at),
    }))
    .filter(
      (it): it is LongTaskSample =>
        it.durationSec !== null && it.completedAt !== '' && it.durationSec > 60
    )
    .sort((a, b) => b.durationSec - a.durationSec)
    .slice(0, LONG_TASK_SAMPLES_LIMIT);

  const recentFailures: RecentFailure[] = failedRows
    .slice(0, RECENT_FAILURES_LIMIT)
    .map((row) => ({
      taskId: row.task_id,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      durationSec: durationSeconds(row.created_at, row.completed_at),
      errorMessage: extractErrorMessage(row),
      killed: isWorkerCancelledKill(row),
    }));

  const killedTotal = failedRows.filter(isWorkerCancelledKill).length;
  const killedAfterFix = failedRows.filter(
    (row) =>
      isWorkerCancelledKill(row) && Date.parse(row.created_at) >= fixMs
  ).length;

  let conclusion: string;
  if (killedAfterFix > 0) {
    conclusion =
      '修复部署后仍出现 WorkerRequestCancelled 杀任务，60s 超时问题未根治，需继续排查';
  } else if (completedOver60s > 0) {
    conclusion = '修复部署后无被杀任务，且存在 >60s 成功完成的生图任务，修复生效';
  } else if (killedTotal > 0) {
    conclusion =
      '窗口内仅有修复部署前的被杀记录，暂无修复后样本；可发一个长耗时生图任务后再查';
  } else {
    conclusion = '窗口内无被杀记录，也无 >60s 完成样本（可能生图任务均较短）';
  }

  return {
    windowHours,
    since: sinceIso,
    fixDeployedAt: FIX_DEPLOYED_AT,
    counts: {
      completed: completedRows.length,
      completedOver60s,
      failed: failedRows.length,
      killedTotal,
      killedAfterFix,
    },
    maxCompletedDurationSec,
    longTaskSamples,
    recentFailures,
    conclusion,
  };
}

async function fetchSlice<T>(
  url: string,
  serviceRoleKey: string,
  deps: TaskMonitorDeps
): Promise<T[]> {
  const doFetch = deps.fetch || fetch;
  const response = await doFetch(url, {
    method: 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `PostgREST request failed: ${response.status} ${body.slice(0, 300)}`
    );
  }
  const rows = (await response.json()) as T[];
  return Array.isArray(rows) ? rows : [];
}

/** Handles one task-monitor request (used by index.ts and tests) */
export async function handleTaskMonitor(
  request: Request,
  env: TaskMonitorEnv,
  deps: TaskMonitorDeps = {}
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const serviceRoleKey = env.SERVICE_ROLE_KEY || '';
  const supabaseUrl = env.SUPABASE_URL || '';
  if (!serviceRoleKey || !supabaseUrl) {
    return jsonResponse(500, {
      error: 'SERVICE_ROLE_KEY / SUPABASE_URL is not configured on the function',
    });
  }

  const jwt = extractBearerToken(request.headers.get('Authorization'));
  if (!jwt) {
    return jsonResponse(401, { error: 'unauthorized: missing bearer token' });
  }
  if (!(await verifyCallerJwt(supabaseUrl, serviceRoleKey, jwt, deps))) {
    return jsonResponse(401, { error: 'unauthorized: invalid token' });
  }
  // 报表经 service_role 绕过 RLS 汇总所有用户任务，仅限管理员查看
  if (!(await isAdminCaller(supabaseUrl, serviceRoleKey, jwt, deps))) {
    return jsonResponse(403, { error: 'forbidden: admin only' });
  }

  const windowHours = await readWindowHoursFromRequest(request);
  const sinceIso = new Date(
    Date.now() - windowHours * 3600 * 1000
  ).toISOString();

  try {
    const [failedRows, completedRows] = await Promise.all([
      fetchSlice<FailedTaskRow>(
        buildFailedSliceUrl(supabaseUrl, sinceIso),
        serviceRoleKey,
        deps
      ),
      fetchSlice<CompletedTaskRow>(
        buildCompletedSliceUrl(supabaseUrl, sinceIso),
        serviceRoleKey,
        deps
      ),
    ]);

    const report = aggregate(
      windowHours,
      sinceIso,
      failedRows,
      completedRows
    );
    return jsonResponse(200, report as unknown as Record<string, unknown>);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown upstream error';
    return jsonResponse(500, { error: message });
  }
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

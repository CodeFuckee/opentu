/**
 * ui-stats Edge Function 核心逻辑（openspec add-button-usage-stats）
 *
 * 职责：
 * - ingest：校验前端采集器批量上报的按钮点击事件，以 service_role 写入
 *   `ui_click_events`（迁移见 supabase/migrations/ui_click_events.sql）
 * - 用户鉴权：有效用户 JWT（经 /auth/v1/user 校验），oa_account 取邮箱 @ 前缀
 *   （与全站口径一致）；不暴露任何查询接口（看板聚合由 dashboard-stats
 *   service_role 直查，非管理员不可见）
 *
 * 纯逻辑（事件规范化/校验）与 REST 编排分离，便于 node:test 注入 fake fetch。
 */

export interface UiStatsEnv {
  SUPABASE_URL: string;
  SERVICE_ROLE_KEY: string;
}

export interface UiStatsDeps {
  fetch?: typeof fetch;
}

export interface IngestEventInput {
  page?: unknown;
  buttonId?: unknown;
  buttonLabel?: unknown;
  appVersion?: unknown;
}

/** 单批事件上限：前端采集器批 20 条/15s，此处放宽到 100 防突发重试风暴 */
export const MAX_EVENTS_PER_BATCH = 100;

const FIELD_MAX_LEN = 200;

export type VerifyUserResult =
  | { ok: true; oaAccount: string }
  | { ok: false; status: number; error: string };

/** 提取 Authorization: Bearer <jwt> */
export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}

/** 邮箱 → oa 账号（@ 前缀）；无邮箱回退 anonymous（与全站口径一致） */
export function oaAccountFromEmail(email: string | null | undefined): string {
  if (!email) return 'anonymous';
  const at = email.indexOf('@');
  const prefix = at > 0 ? email.slice(0, at) : email;
  return prefix.trim() || 'anonymous';
}

/**
 * 校验用户 JWT 并解析 oa_account。
 * 以用户 JWT 调 /auth/v1/user（网关已做 verify_jwt，此处再验有效性并取邮箱）。
 */
export async function verifyUser(
  env: UiStatsEnv,
  request: Request,
  deps: UiStatsDeps = {}
): Promise<VerifyUserResult> {
  const jwt = extractBearerToken(request.headers.get('Authorization'));
  if (!jwt) {
    return { ok: false, status: 401, error: 'unauthorized: missing bearer token' };
  }
  const doFetch = deps.fetch || fetch;
  const base = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  try {
    const authRes = await doFetch(`${base}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: env.SERVICE_ROLE_KEY,
        Authorization: `Bearer ${jwt}`,
      },
    });
    if (!authRes.ok) {
      return { ok: false, status: 401, error: 'unauthorized: invalid token' };
    }
    const user = (await authRes.json()) as { email?: unknown };
    const email = typeof user.email === 'string' ? user.email : null;
    return { ok: true, oaAccount: oaAccountFromEmail(email) };
  } catch {
    return { ok: false, status: 401, error: 'unauthorized: token check failed' };
  }
}

export type NormalizeResult =
  | { ok: true; rows: Record<string, string>[] }
  | { ok: false; status: number; error: string };

function fieldToString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 规范化与校验一批事件：
 * - events 必须是非空数组且 ≤ MAX_EVENTS_PER_BATCH
 * - 每条必填 page / buttonId（字符串，截断到 200）
 * - 输出 PostgREST 列名（snake_case）行，created_at 交由数据库 default now()
 *   （客户端时钟不可信，不做端侧时间戳）
 */
export function normalizeEvents(
  raw: unknown
): NormalizeResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, status: 400, error: 'bad request: events must be a non-empty array' };
  }
  if (raw.length > MAX_EVENTS_PER_BATCH) {
    return {
      ok: false,
      status: 400,
      error: `bad request: batch too large (max ${MAX_EVENTS_PER_BATCH})`,
    };
  }
  const rows: Record<string, string>[] = [];
  for (const item of raw) {
    const event = (item ?? {}) as IngestEventInput;
    const page = fieldToString(event.page);
    const buttonId = fieldToString(event.buttonId);
    if (!page || !buttonId) {
      return { ok: false, status: 400, error: 'bad request: page and buttonId are required' };
    }
    rows.push({
      page: page.slice(0, FIELD_MAX_LEN),
      button_id: buttonId.slice(0, FIELD_MAX_LEN),
      button_label: fieldToString(event.buttonLabel)?.slice(0, FIELD_MAX_LEN) ?? '',
      app_version: fieldToString(event.appVersion)?.slice(0, FIELD_MAX_LEN) ?? '',
    });
  }
  return { ok: true, rows };
}

export type IngestResult =
  | { ok: true; inserted: number }
  | { ok: false; status: number; error: string };

/** ingest 编排：鉴权 → 规范化 → service_role 批量插入 */
export async function ingestEvents(
  env: UiStatsEnv,
  request: Request,
  deps: UiStatsDeps = {}
): Promise<IngestResult> {
  const user = await verifyUser(env, request, deps);
  if (!user.ok) {
    return user;
  }

  let body: { events?: unknown };
  try {
    body = (await request.json()) as { events?: unknown };
  } catch {
    return { ok: false, status: 400, error: 'bad request: invalid json body' };
  }

  const normalized = normalizeEvents(body.events);
  if (!normalized.ok) {
    return normalized;
  }

  // oa_account 以服务端解析为准（不信任端侧上报）
  const rows = normalized.rows.map((row) => ({ ...row, oa_account: user.oaAccount }));

  const doFetch = deps.fetch || fetch;
  const base = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  try {
    const insertRes = await doFetch(`${base}/rest/v1/ui_click_events`, {
      method: 'POST',
      headers: {
        apikey: env.SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (!insertRes.ok) {
      const detail = (await insertRes.text()).slice(0, 200);
      console.error(`[ui-stats] insert failed: ${insertRes.status} ${detail}`);
      return { ok: false, status: 502, error: 'upstream insert failed' };
    }
    return { ok: true, inserted: rows.length };
  } catch {
    return { ok: false, status: 502, error: 'upstream insert failed' };
  }
}

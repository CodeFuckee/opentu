/**
 * check-email Edge Function core logic (no Deno dependency, unit-testable)
 *
 * Separated from index.ts: index.ts only handles Deno.serve / env vars,
 * this file holds parameter validation and the Admin API query logic.
 */

export interface CheckEmailDeps {
  /** Injected HTTP client for testing; defaults to global fetch */
  fetch?: typeof fetch;
}

/** 单页条数（GoTrue admin users 每页上限） */
const ADMIN_USERS_PER_PAGE = 1000;

/** 分页遍历的安全上限（50000 用户），防止异常响应导致死循环 */
const ADMIN_USERS_MAX_PAGES = 50;

export function buildAdminUrl(supabaseUrl: string, page = 1): string {
  const base = `${(supabaseUrl || '').replace(/\/$/, '')}/auth/v1/admin`;
  return `${base}/users?per_page=${ADMIN_USERS_PER_PAGE}&page=${page}`;
}

export function isValidEmail(email: string): boolean {
  return !!email && email.includes('@');
}

export async function isEmailRegistered(
  email: string,
  serviceRoleKey: string,
  supabaseUrl: string,
  deps: CheckEmailDeps = {}
): Promise<boolean> {
  const doFetch = deps.fetch || fetch;
  const target = email.trim().toLowerCase();

  // 自托管 GoTrue 会忽略过滤参数，只能翻页拉取后本地匹配。
  // 必须遍历全部分页：只拉第一页时，用户数超过一页后已注册邮箱会被误判为未注册。
  for (let page = 1; page <= ADMIN_USERS_MAX_PAGES; page++) {
    const response = await doFetch(buildAdminUrl(supabaseUrl, page), {
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
        `Admin API request failed: ${response.status} ${body.slice(0, 300)}`
      );
    }

    // GoTrue admin users endpoint returns { users: Array<{ email, id, ... }> }.
    const payload = (await response.json()) as {
      users?: Array<{ email?: string }>;
    };
    const users = Array.isArray(payload.users) ? payload.users : [];
    if (
      users.some(
        (user) =>
          typeof user.email === 'string' &&
          user.email.toLowerCase() === target
      )
    ) {
      return true;
    }

    // 不满一页说明已到最后一页
    if (users.length < ADMIN_USERS_PER_PAGE) {
      return false;
    }
  }
  return false;
}

/** Handles one check-email request (used by index.ts and tests) */
export async function handleCheckEmail(
  request: Request,
  env: { SERVICE_ROLE_KEY?: string; SUPABASE_URL?: string },
  deps: CheckEmailDeps = {}
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const serviceRoleKey = env.SERVICE_ROLE_KEY || '';
  if (!serviceRoleKey) {
    return jsonResponse(500, {
      error: 'SERVICE_ROLE_KEY is not configured on the function',
    });
  }

  let email = '';
  try {
    const payload = (await request.json()) as { email?: unknown };
    email = typeof payload.email === 'string' ? payload.email.trim() : '';
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!isValidEmail(email)) {
    return jsonResponse(400, { error: 'email is required and must be valid' });
  }

  try {
    const registered = await isEmailRegistered(
      email,
      serviceRoleKey,
      env.SUPABASE_URL || 'http://localhost',
      deps
    );
    return jsonResponse(200, { registered });
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
    headers: { 'Content-Type': 'application/json' },
  });
}

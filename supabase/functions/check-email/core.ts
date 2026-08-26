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

export function buildAdminUrl(supabaseUrl: string): string {
  const base = `${(supabaseUrl || '').replace(/\/$/, '')}/auth/v1/admin`;
  return `${base}/users?per_page=1000`;
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
  const url = buildAdminUrl(supabaseUrl);

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
      `Admin API request failed: ${response.status} ${body.slice(0, 300)}`
    );
  }

  // GoTrue admin users endpoint returns { users: Array<{ email, id, ... }> }.
  // Note: the self-hosted instance ignores the `filter` param, so we fetch the
  // full list and match the email locally.
  const payload = (await response.json()) as {
    users?: Array<{ email?: string }>;
  };
  const users = Array.isArray(payload.users) ? payload.users : [];
  const target = email.trim().toLowerCase();
  return users.some(
    (user) =>
      typeof user.email === 'string' &&
      user.email.toLowerCase() === target
  );
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

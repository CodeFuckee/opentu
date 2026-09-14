/**
 * feedbackland-sso Edge Function 单测（node:test）
 *
 * 覆盖：
 * - OPTIONS 预检 → 200 + CORS 头
 * - 未带/无效 JWT → 401，且不调用 admin generate_link
 * - 有效 JWT 但用户无 email → 400
 * - 有效 JWT → 按 JWT 中的 email 调 magiclink generate_link（Bearer=service role），
 *   返回 { token_hash }（hashed_token 优先，缺失时从 action_link 解析）
 * - generate_link 失败（用户不存在等）→ 透传 404 与错误信息
 * - extractTokenHashFromActionLink：正常解析 / 缺 token 返回 null
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBearerToken,
  extractTokenHashFromActionLink,
  handleFeedbackSsoRequest,
} from './core.ts';

const SUPABASE_URL = 'http://supabase.local';
const SRK = 'service-role-key';

interface Route {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response;
}

function routeFetch(routes: Route[], calls: string[] = []) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const route of routes) {
      if (route.match(url, init)) {
        return route.respond(url, init);
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const ssoRequest = (token?: string) =>
  new Request('http://opentu.local/functions/v1/feedbackland-sso', {
    method: 'POST',
    headers: token
      ? { Authorization: `Bearer ${token}`, apikey: 'anon-key' }
      : { apikey: 'anon-key' },
  });

// GoTrue /auth/v1/user：token 有效时返回用户
const userRoute = (email: string | null, token = 'valid-jwt'): Route => ({
  match: (url) => url.includes('/auth/v1/user'),
  respond: (url, init) => {
    const auth = new Headers(init?.headers).get('Authorization') || '';
    if (!auth.includes(`Bearer ${token}`)) {
      return json(401, { message: 'invalid claim' });
    }
    return json(200, {
      id: 'user-1',
      email,
      ...(email ? {} : { email_confirmed_at: null }),
    });
  },
});

const ACTION_LINK =
  'http://supabase.local/auth/v1/verify?token=hashed-token-abc&type=magiclink&redirect_to=http://10.37.80.25:8090/yjk';

// GoTrue /auth/v1/admin/generate_link
const generateLinkRoute = (
  status: number,
  body: unknown,
  onCall?: (init?: RequestInit) => void
): Route => ({
  match: (url) => url.includes('/auth/v1/admin/generate_link'),
  respond: (url, init) => {
    onCall?.(init);
    return json(status, body);
  },
});

test('OPTIONS 预检返回 200 并带 CORS 头', async () => {
  const response = await handleFeedbackSsoRequest(
    new Request('http://opentu.local/functions/v1/feedbackland-sso', {
      method: 'OPTIONS',
    }),
    { supabaseUrl: SUPABASE_URL, serviceRoleKey: SRK, fetch: routeFetch([], []) }
  );
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('access-control-allow-origin'));
  assert.match(response.headers.get('access-control-allow-headers') || '', /authorization/i);
});

test('未带 Authorization → 401，且不调用 generate_link', async () => {
  const calls: string[] = [];
  const response = await handleFeedbackSsoRequest(ssoRequest(), {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SRK,
    fetch: routeFetch(
      [userRoute('user@yjk.com'), generateLinkRoute(200, {}, () => {
        throw new Error('不应调用 generate_link');
      })],
      calls
    ),
  });
  assert.equal(response.status, 401);
  assert.ok(!calls.some((c) => c.includes('generate_link')));
});

test('无效 JWT（/auth/v1/user 返回 401）→ 401，且不调用 generate_link', async () => {
  const calls: string[] = [];
  const response = await handleFeedbackSsoRequest(ssoRequest('bad-token'), {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SRK,
    fetch: routeFetch(
      [
        userRoute('user@yjk.com', 'valid-jwt'),
        generateLinkRoute(200, {}, () => {
          throw new Error('不应调用 generate_link');
        }),
      ],
      calls
    ),
  });
  assert.equal(response.status, 401);
  assert.ok(!calls.some((c) => c.includes('generate_link')));
});

test('有效 JWT 但用户无 email → 400', async () => {
  const response = await handleFeedbackSsoRequest(ssoRequest('valid-jwt'), {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SRK,
    fetch: routeFetch([
      userRoute(null, 'valid-jwt'),
      generateLinkRoute(200, {}, () => {
        throw new Error('不应调用 generate_link');
      }),
    ]),
  });
  assert.equal(response.status, 400);
});

test('有效 JWT → 以 JWT 中的 email 调 magiclink generate_link（Bearer=SRK）→ 返回 token_hash', async () => {
  let seenInit: RequestInit | undefined;
  const response = await handleFeedbackSsoRequest(ssoRequest('valid-jwt'), {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SRK,
    fetch: routeFetch([
      userRoute('user@yjk.com', 'valid-jwt'),
      generateLinkRoute(
        200,
        {
          action_link: ACTION_LINK,
          hashed_token: 'hashed-token-abc',
          verification_type: 'magiclink',
        },
        (init) => {
          seenInit = init;
        }
      ),
    ]),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { token_hash: string };
  assert.equal(body.token_hash, 'hashed-token-abc');

  assert.ok(seenInit);
  assert.equal(
    new Headers(seenInit.headers).get('Authorization'),
    `Bearer ${SRK}`
  );
  const requestBody = JSON.parse(String(seenInit.body));
  assert.equal(requestBody.type, 'magiclink');
  assert.equal(requestBody.email, 'user@yjk.com');
});

test('hashed_token 缺失时从 action_link 解析 token', async () => {
  const response = await handleFeedbackSsoRequest(ssoRequest('valid-jwt'), {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SRK,
    fetch: routeFetch([
      userRoute('user@yjk.com', 'valid-jwt'),
      generateLinkRoute(200, { action_link: ACTION_LINK }),
    ]),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { token_hash: string };
  assert.equal(body.token_hash, 'hashed-token-abc');
});

test('generate_link 失败（如用户不存在）→ 404 透传错误信息', async () => {
  const response = await handleFeedbackSsoRequest(ssoRequest('valid-jwt'), {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SRK,
    fetch: routeFetch([
      userRoute('ghost@yjk.com', 'valid-jwt'),
      generateLinkRoute(404, { message: 'User from sub claim in JWT does not exist' }),
    ]),
  });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /exist/i);
});

test('extractTokenHashFromActionLink：正常解析 token 参数', () => {
  assert.equal(extractTokenHashFromActionLink(ACTION_LINK), 'hashed-token-abc');
});

test('extractTokenHashFromActionLink：缺 token 参数或非法 URL 返回 null', () => {
  assert.equal(
    extractTokenHashFromActionLink('http://supabase.local/auth/v1/verify?type=magiclink'),
    null
  );
  assert.equal(extractTokenHashFromActionLink('not-a-url'), null);
});

test('extractBearerToken：Bearer 头提取 / 缺失返回 null', () => {
  assert.equal(extractBearerToken(ssoRequest('abc')), 'abc');
  assert.equal(extractBearerToken(ssoRequest()), null);
});

/**
 * check-email Edge Function unit tests (node:test)
 *
 * Reproduction scenario: the frontend cannot distinguish "email not registered"
 * from "wrong password"; this function queries the GoTrue Admin API with the
 * SERVICE_ROLE_KEY to answer precisely.
 *
 * Run: node --test supabase/functions/check-email/core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdminUrl,
  isValidEmail,
  handleCheckEmail,
} from './core.ts';

function makeUsers(n: number, emailPrefix = 'u'): Array<{ id: string; email: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, email: `${emailPrefix}${i}@b.com` }));
}

function jsonFetchMock(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown }
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const result = handler(url, init);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/functions/v1/check-email', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const ENV = {
  SERVICE_ROLE_KEY: 'test-service-role-key',
  SUPABASE_URL: 'http://10.37.80.25:8021',
};

test('buildAdminUrl builds the admin users list URL', () => {
  const url = buildAdminUrl('http://10.37.80.25:8021/');
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/auth/v1/admin/users');
  assert.ok(parsed.searchParams.get('per_page'));
});

test('isValidEmail validates', () => {
  assert.equal(isValidEmail('a@b.com'), true);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail('not-an-email'), false);
});

test('registered email: admin list contains it -> registered=true', async () => {
  const fetchMock = jsonFetchMock((url, init) => {
    assert.ok(url.includes('/auth/v1/admin/users'));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-service-role-key');
    assert.equal(headers.get('apikey'), 'test-service-role-key');
    return {
      status: 200,
      body: { users: [{ id: 'u1', email: 'a@b.com' }], aud: 'authenticated' },
    };
  });

  const response = await handleCheckEmail(postRequest({ email: 'a@b.com' }), ENV, {
    fetch: fetchMock,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { registered: true });
});

test('unregistered email: admin list lacks it -> registered=false', async () => {
  const fetchMock = jsonFetchMock(() => ({
    status: 200,
    body: {
      users: [{ id: 'u1', email: 'other@example.com' }],
      aud: 'authenticated',
    },
  }));

  const response = await handleCheckEmail(
    postRequest({ email: 'nobody@example.com' }),
    ENV,
    { fetch: fetchMock }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { registered: false });
});

test('email matching is case-insensitive', async () => {
  const fetchMock = jsonFetchMock(() => ({
    status: 200,
    body: {
      users: [{ id: 'u1', email: 'User@Example.com' }],
      aud: 'authenticated',
    },
  }));

  const response = await handleCheckEmail(
    postRequest({ email: 'user@example.com' }),
    ENV,
    { fetch: fetchMock }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { registered: true });
});

test('admin API error (non-200) -> 500 with error info', async () => {
  const fetchMock = jsonFetchMock(() => ({
    status: 500,
    body: { message: 'boom' },
  }));

  const response = await handleCheckEmail(postRequest({ email: 'a@b.com' }), ENV, {
    fetch: fetchMock,
  });
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.ok(body.error.includes('Admin API request failed'));
});

test('missing SERVICE_ROLE_KEY -> 500', async () => {
  const response = await handleCheckEmail(
    postRequest({ email: 'a@b.com' }),
    { SERVICE_ROLE_KEY: '', SUPABASE_URL: ENV.SUPABASE_URL },
    { fetch: jsonFetchMock(() => ({ status: 200, body: { users: [] } })) }
  );
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.ok(body.error.includes('SERVICE_ROLE_KEY'));
});

test('invalid request: non-POST -> 405', async () => {
  const request = new Request('http://localhost/functions/v1/check-email', {
    method: 'GET',
  });
  const response = await handleCheckEmail(request, ENV, {
    fetch: jsonFetchMock(() => ({ status: 200, body: { users: [] } })),
  });
  assert.equal(response.status, 405);
});

test('invalid request: missing/invalid email -> 400', async () => {
  for (const body of [{}, { email: '' }, { email: 'not-an-email' }]) {
    const response = await handleCheckEmail(postRequest(body), ENV, {
      fetch: jsonFetchMock(() => ({ status: 200, body: { users: [] } })),
    });
    assert.equal(response.status, 400);
  }
});

// ---------------------------------------------------------------------------
// 回归：用户数超过一页（per_page=1000）后，已注册邮箱曾被误判为未注册
// ---------------------------------------------------------------------------

test('超过一页：第一页未命中且满页 → 继续翻页并在第二页命中', async () => {
  const pagesFetched: string[] = [];
  const fetchMock = jsonFetchMock((url) => {
    pagesFetched.push(url);
    if (new URL(url).searchParams.get('page') === '1') {
      return { status: 200, body: { users: makeUsers(1000) } };
    }
    return { status: 200, body: { users: [{ id: 'target', email: 'a@b.com' }] } };
  });

  const response = await handleCheckEmail(postRequest({ email: 'a@b.com' }), ENV, {
    fetch: fetchMock,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { registered: true });
  assert.equal(pagesFetched.length, 2);
  assert.ok(pagesFetched[0].includes('page=1'));
  assert.ok(pagesFetched[1].includes('page=2'));
});

test('未注册：遍历到不满一页的末页 → registered=false', async () => {
  const pagesFetched: string[] = [];
  const fetchMock = jsonFetchMock((url) => {
    pagesFetched.push(url);
    if (new URL(url).searchParams.get('page') === '1') {
      return { status: 200, body: { users: makeUsers(1000) } };
    }
    return { status: 200, body: { users: makeUsers(3) } };
  });

  const response = await handleCheckEmail(postRequest({ email: 'zz@b.com' }), ENV, {
    fetch: fetchMock,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { registered: false });
  assert.equal(pagesFetched.length, 2);
});

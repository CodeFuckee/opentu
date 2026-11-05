import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SupabaseAuthError,
  createSupabaseAuth,
} from '../src/supabase-auth.js';

function jsonResponse(status, body) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  };
}

/** 可编程 mock fetch：按 URL 前缀路由，记录全部调用 */
function createMockFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [match, handler] of handlers) {
      if (typeof match === 'string' ? url.includes(match) : match(url, init)) {
        return handler(url, init, calls.length);
      }
    }
    throw new Error(`mock fetch 未匹配: ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const AUTH_OK = (token) =>
  jsonResponse(200, {
    access_token: token,
    refresh_token: `${token}-rt`,
    expires_in: 3600,
    user: { id: 'user-1', email: 'chen@example.com' },
  });

function makeAuth(fetchImpl, overrides = {}) {
  let now = 1_000_000_000_000;
  const auth = createSupabaseAuth({
    supabaseUrl: 'http://sb.test',
    anonKey: 'anon-key',
    email: 'chen@example.com',
    password: 'pw',
    fetchImpl,
    nowFn: () => now,
    logger: { warn() {} },
    ...overrides,
  });
  return { auth, advance: (ms) => (now += ms) };
}

test('登录：密码换 token，暴露 userId/email', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => AUTH_OK('at-1')],
  ]);
  const { auth } = makeAuth(fetchImpl);
  assert.equal(await auth.getAccessToken(), 'at-1');
  assert.deepEqual(auth.getUser(), { id: 'user-1', email: 'chen@example.com' });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'http://sb.test/auth/v1/token?grant_type=password');
  assert.equal(call.init.headers.apikey, 'anon-key');
  assert.deepEqual(JSON.parse(call.init.body), {
    email: 'chen@example.com',
    password: 'pw',
  });
});

test('未过期时直接复用缓存 token，不发请求', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => AUTH_OK('at-1')],
  ]);
  const { auth } = makeAuth(fetchImpl);
  await auth.getAccessToken();
  await auth.getAccessToken();
  await auth.getAccessToken();
  assert.equal(fetchImpl.calls.length, 1);
});

test('过期（含 30s 提前量）后用 refresh_token 刷新', async () => {
  const fetchImpl = createMockFetch([
    ['grant_type=password', () => AUTH_OK('at-1')],
    ['grant_type=refresh_token', () => AUTH_OK('at-2')],
  ]);
  const { auth, advance } = makeAuth(fetchImpl);
  assert.equal(await auth.getAccessToken(), 'at-1');
  advance(3600 * 1000 - 29 * 1000); // 到期前 29s（进入提前量窗口）
  assert.equal(await auth.getAccessToken(), 'at-2');
  const refreshCall = fetchImpl.calls[1];
  assert.ok(refreshCall.url.includes('grant_type=refresh_token'));
  assert.deepEqual(JSON.parse(refreshCall.init.body), { refresh_token: 'at-1-rt' });
});

test('刷新失败降级重登（密码被改后仍能拿新会话）', async () => {
  const fetchImpl = createMockFetch([
    ['grant_type=password', (_u, _i, seq) => AUTH_OK(seq === 1 ? 'at-1' : 'at-3')],
    ['grant_type=refresh_token', () => jsonResponse(400, { error: 'invalid_grant' })],
  ]);
  const { auth, advance } = makeAuth(fetchImpl);
  assert.equal(await auth.getAccessToken(), 'at-1');
  advance(3600 * 1000);
  assert.equal(await auth.getAccessToken(), 'at-3'); // refresh 400 → 自动重登
  assert.equal(fetchImpl.calls[1].url.includes('grant_type=refresh_token'), true);
  assert.equal(fetchImpl.calls[2].url.includes('grant_type=password'), true);
});

test('invalidate 后强制重登', async () => {
  const fetchImpl = createMockFetch([
    ['grant_type=password', (_u, _i, seq) => AUTH_OK(seq === 1 ? 'at-1' : 'at-2')],
  ]);
  const { auth } = makeAuth(fetchImpl);
  await auth.getAccessToken();
  auth.invalidate();
  assert.equal(await auth.getAccessToken(), 'at-2');
  assert.equal(fetchImpl.calls.length, 2);
});

test('并发取 token 合并为一次登录（single-flight）', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => AUTH_OK('at-1')],
  ]);
  const { auth } = makeAuth(fetchImpl);
  const [a, b, c] = await Promise.all([
    auth.getAccessToken(),
    auth.getAccessToken(),
    auth.getAccessToken(),
  ]);
  assert.equal(a, 'at-1');
  assert.equal(b, 'at-1');
  assert.equal(c, 'at-1');
  assert.equal(fetchImpl.calls.length, 1);
});

test('凭据错误抛 SupabaseAuthError（带 status 与响应体）', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () =>
      jsonResponse(400, { error: 'invalid_credentials', msg: 'Invalid login credentials' })],
  ]);
  const { auth } = makeAuth(fetchImpl);
  await assert.rejects(
    () => auth.getAccessToken(),
    (error) => {
      assert.ok(error instanceof SupabaseAuthError);
      assert.equal(error.status, 400);
      assert.ok(error.message.includes('Invalid login credentials'));
      return true;
    }
  );
});

test('认证服务不可达抛网络类错误', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const { auth } = makeAuth(fetchImpl);
  await assert.rejects(
    () => auth.getAccessToken(),
    (error) => {
      assert.ok(error instanceof SupabaseAuthError);
      assert.ok(error.message.includes('不可达'));
      return true;
    }
  );
});

/**
 * newapi-key Edge Function 单测（node:test）
 *
 * 覆盖完整流程：
 * - apikey 已存在 → 直接返回，不调用 new-api
 * - 首次创建：建用户 → 设额度 200 → 登录 → 建令牌 → 写 apikey
 * - 用户已存在 → 跳过创建/额度
 * - configs 缺失 → 报错
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getOrCreateApiKey,
  generateRandomPassword,
  readConfigValue,
  readProfileValue,
} from './core.ts';

const SUPABASE_URL = 'http://supabase.local';
const SRK = 'service-role-key';
const NEWAPI_URL = 'http://newapi.local:3000';
const NEWAPI_TOKEN = 'admin-token';

function jsonFetchMock(
  handler: (url: string, init?: RequestInit) => {
    status: number;
    body: unknown;
  }
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

test('apikey 已存在时直接返回，不调用 new-api', async () => {
  let newApiCalled = false;
  const fetchMock = jsonFetchMock((url) => {
    if (url.includes('/rest/v1/user_profiles') && url.includes('select=apikey')) {
      return { status: 200, body: [{ apikey: 'sk-existing' }] };
    }
    if (url.includes('newapi.local')) {
      newApiCalled = true;
      return { status: 200, body: {} };
    }
    return { status: 200, body: [] };
  });

  const result = await getOrCreateApiKey(
    SUPABASE_URL,
    SRK,
    'user-1',
    'zhangsan',
    { fetch: fetchMock }
  );
  assert.equal(result.apikey, 'sk-existing');
  assert.equal(newApiCalled, false, '不应调用 new-api');
});

test('首次创建：建用户 → 设额度 200 → 登录 → 建令牌 → 写 apikey', async () => {
  const calls: string[] = [];
  let searchCount = 0;
  const fetchMock = jsonFetchMock((url, init) => {
    calls.push(url);
    const method = init?.method || 'GET';
    if (url.includes('/rest/v1/user_profiles') && url.includes('select=apikey')) {
      return { status: 200, body: [] }; // apikey 为空
    }
    if (url.includes('/rest/v1/configs') && url.includes('NEWAPI_URL')) {
      return { status: 200, body: [{ value: NEWAPI_URL }] };
    }
    if (url.includes('/rest/v1/configs') && url.includes('NEWAPI_TOKEN')) {
      return { status: 200, body: [{ value: NEWAPI_TOKEN }] };
    }
    if (url.includes('/rest/v1/user_profiles') && url.includes('select=newapi_password')) {
      return { status: 200, body: [] }; // 无存储密码
    }
    if (url.includes('/rest/v1/user_profiles') && method === 'POST') {
      return { status: 201, body: [] };
    }
    if (url.includes('/api/user/search')) {
      searchCount += 1;
      // 第一次：用户不存在；第二次（创建后）：用户已存在（id=7）
      return {
        status: 200,
        body:
          searchCount === 1
            ? { data: { items: [] } }
            : { data: { items: [{ id: 7, username: 'zhangsan', quota: 0 }] } },
      };
    }
    if (url.includes('/api/user/manage')) {
      return { status: 200, body: { success: true, message: '' } };
    }
    if (url.includes('/api/user/login')) {
      return {
        status: 200,
        body: { success: true, data: { access_token: 'user-jwt' } },
      };
    }
    if (url.includes('/api/user/') && method === 'POST') {
      return { status: 200, body: { success: true, message: '' } };
    }
    if (/\/api\/token\/\d+\/key$/.test(url) && method === 'POST') {
      return {
        status: 200,
        body: { success: true, data: { key: 'b'.repeat(48) } },
      };
    }
    if (url.includes('/api/token/search') && method === 'GET') {
      const keyword = decodeURIComponent(
        url.split('keyword=')[1]?.split('&')[0] || ''
      );
      return {
        status: 200,
        body: { data: { items: [{ id: 55, name: keyword }] }, success: true },
      };
    }
    if (url.includes('/api/token/') && method === 'POST') {
      return {
        status: 200,
        body: { success: true, message: '' },
      };
    }
    return { status: 200, body: {} };
  });

  const result = await getOrCreateApiKey(
    SUPABASE_URL,
    SRK,
    'user-1',
    'zhangsan',
    { fetch: fetchMock, generatePassword: () => 'GenPass123!' }
  );
  assert.equal(result.apikey, 'sk-' + 'b'.repeat(48));

  // 断言调用了建用户、设额度、登录、建令牌
  const userCreate = calls.find((u) => u.endsWith('/api/user/'));
  assert.ok(userCreate, '应调用创建用户');
  const quotaCall = calls.find((u) => u.includes('/api/user/manage'));
  assert.ok(quotaCall, '应调用设额度');
  assert.ok(calls.some((u) => u.includes('/api/user/login')), '应调用登录');
  assert.ok(calls.some((u) => u.includes('/api/token/')), '应调用建令牌');
  assert.ok(
    calls.some((u) => /\/api\/token\/\d+\/key$/.test(u)),
    '应通过专用端点取完整 key'
  );
});

test('用户已存在时跳过创建用户与设额度', async () => {
  const calls: string[] = [];
  const fetchMock = jsonFetchMock((url, init) => {
    calls.push(url);
    const method = init?.method || 'GET';
    if (url.includes('/rest/v1/user_profiles') && url.includes('select=apikey')) {
      return { status: 200, body: [] };
    }
    if (url.includes('/rest/v1/configs') && url.includes('NEWAPI_URL')) {
      return { status: 200, body: [{ value: NEWAPI_URL }] };
    }
    if (url.includes('/rest/v1/configs') && url.includes('NEWAPI_TOKEN')) {
      return { status: 200, body: [{ value: NEWAPI_TOKEN }] };
    }
    if (url.includes('/rest/v1/user_profiles') && url.includes('select=newapi_password')) {
      return { status: 200, body: [{ newapi_password: 'StoredPass1!' }] };
    }
    if (url.includes('/rest/v1/user_profiles') && method === 'POST') {
      return { status: 201, body: [] };
    }
    if (url.includes('/api/user/search')) {
      return {
        status: 200,
        body: { data: { items: [{ id: 9, username: 'zhangsan', quota: 0 }] } },
      };
    }
    if (url.includes('/api/user/login')) {
      return {
        status: 200,
        body: { success: true, data: { access_token: 'user-jwt' } },
      };
    }
    if (/\/api\/token\/\d+\/key$/.test(url) && method === 'POST') {
      return {
        status: 200,
        body: { success: true, data: { key: 'd'.repeat(48) } },
      };
    }
    if (url.includes('/api/token/search') && method === 'GET') {
      const keyword = decodeURIComponent(
        url.split('keyword=')[1]?.split('&')[0] || ''
      );
      return {
        status: 200,
        body: { data: { items: [{ id: 56, name: keyword }] }, success: true },
      };
    }
    if (url.includes('/api/token/') && method === 'POST') {
      return {
        status: 200,
        body: { success: true, message: '' },
      };
    }
    return { status: 200, body: {} };
  });

  const result = await getOrCreateApiKey(
    SUPABASE_URL,
    SRK,
    'user-1',
    'zhangsan',
    { fetch: fetchMock, generatePassword: () => 'GenPass123!' }
  );
  assert.equal(result.apikey, 'sk-' + 'd'.repeat(48));
  // 不应调用创建用户 / 设额度
  assert.ok(!calls.some((u) => u.endsWith('/api/user/')), '不应创建用户');
  assert.ok(!calls.some((u) => u.includes('/api/user/manage')), '不应设额度');
  // 登录用存储的密码
  const loginCall = calls.find((u) => u.includes('/api/user/login'));
  assert.ok(loginCall);
});

test('configs 缺少 NEWAPI_TOKEN 时报错', async () => {
  const fetchMock = jsonFetchMock((url) => {
    if (url.includes('/rest/v1/user_profiles') && url.includes('select=apikey')) {
      return { status: 200, body: [] };
    }
    if (url.includes('/rest/v1/configs') && url.includes('NEWAPI_URL')) {
      return { status: 200, body: [{ value: NEWAPI_URL }] };
    }
    if (url.includes('/rest/v1/configs') && url.includes('NEWAPI_TOKEN')) {
      return { status: 200, body: [] };
    }
    return { status: 200, body: [] };
  });

  await assert.rejects(
    () =>
      getOrCreateApiKey(SUPABASE_URL, SRK, 'user-1', 'zhangsan', {
        fetch: fetchMock,
      }),
    /NEWAPI_URL or NEWAPI_TOKEN not configured/
  );
});

test('generateRandomPassword 生成合规密码', () => {
  const pwd = generateRandomPassword();
  assert.equal(pwd.length, 16);
});

test('readConfigValue / readProfileValue 基础读取', async () => {
  const fetchMock = jsonFetchMock((url) => {
    if (url.includes('/rest/v1/configs')) {
      return { status: 200, body: [{ value: 'some-value' }] };
    }
    return { status: 200, body: [{ apikey: 'sk-x' }] };
  });
  assert.equal(
    await readConfigValue(SUPABASE_URL, SRK, 'NEWAPI_URL', { fetch: fetchMock }),
    'some-value'
  );
  assert.equal(
    await readProfileValue(SUPABASE_URL, SRK, 'u1', 'apikey', { fetch: fetchMock }),
    'sk-x'
  );
});

// ============================================================
// 复现缺陷：平台已有同名用户时，新生成密码必须同步到平台才能登录；
// 以及：完整 token key 只能经 POST /api/token/:id/key 获取，
// 列表/搜索接口一律打码（真实 new-api GetMaskedKey 行为）。
// ============================================================

function maskKey(key: string): string {
  if (key.length <= 8) {
    return '*'.repeat(key.length);
  }
  return `${key.slice(0, 4)}${'*'.repeat(key.length - 8)}${key.slice(-4)}`;
}

function jsonFetchHelper(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createPlatformSimMock(options: {
  platformPassword: string;
  storedDbPassword?: string | null;
}) {
  let storedDbPassword = options.storedDbPassword ?? null;
  const platformPasswords: Record<string, string> = {
    zhangsan: options.platformPassword,
  };
  const tokens = new Map<number, { id: number; name: string; key: string }>();
  let nextTokenId = 1;
  let savedApiKey: string | null = null;
  let savedSyncedPassword: string | null = null;
  const calls: string[] = [];

  const fetchMock = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method || 'GET';
    calls.push(`${method} ${url}`);
    const rawBody = typeof init?.body === 'string' ? init.body : '';

    if (url.includes('/rest/v1/user_profiles') && url.includes('select=apikey')) {
      return jsonFetchHelper(savedApiKey ? [{ apikey: savedApiKey }] : []);
    }
    if (url.includes('select=newapi_password')) {
      return jsonFetchHelper(
        storedDbPassword ? [{ newapi_password: storedDbPassword }] : []
      );
    }
    if (url.includes('/rest/v1/configs')) {
      return jsonFetchHelper([{ value: 'http://newapi.local:3000' }]);
    }
    if (url.includes('on_conflict=user_id')) {
      const payload = JSON.parse(rawBody) as {
        apikey?: string;
        newapi_password?: string;
      };
      if (payload.newapi_password !== undefined) {
        storedDbPassword = payload.newapi_password;
        savedSyncedPassword = payload.newapi_password;
      }
      if (payload.apikey !== undefined) {
        savedApiKey = payload.apikey;
      }
      return jsonFetchHelper({});
    }
    if (/\/api\/token\/\d+\/key$/.test(url) && method === 'POST') {
      const id = Number(url.match(/\/api\/token\/(\d+)\/key/)![1]);
      const token = tokens.get(id);
      return jsonFetchHelper(
        token
          ? { success: true, data: { key: token.key } }
          : { success: false, message: 'no such token' }
      );
    }
    if (url.includes('/api/token/search') && method === 'GET') {
      const keyword = decodeURIComponent(
        url.split('keyword=')[1]?.split('&')[0] || ''
      );
      const items = [...tokens.values()]
        .filter((t) => t.name.includes(keyword))
        .map((t) => ({ id: t.id, name: t.name, key: maskKey(t.key) }));
      return jsonFetchHelper({ data: { items }, success: true });
    }
    if (url.includes('/api/token/') && method === 'POST' && !url.endsWith('/key')) {
      const payload = JSON.parse(rawBody) as { name: string };
      const key = Array.from({ length: 48 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join('');
      tokens.set(nextTokenId, { id: nextTokenId, name: payload.name, key });
      nextTokenId += 1;
      return jsonFetchHelper({ success: true, message: '' });
    }
    if (url.includes('/api/user/search')) {
      return jsonFetchHelper({
        data: { items: [{ id: 7, username: 'zhangsan', quota: 123 }] },
        success: true,
      });
    }
    if (url.includes('/api/user/') && method === 'PUT') {
      const payload = JSON.parse(rawBody) as {
        username: string;
        password: string;
      };
      platformPasswords[payload.username] = payload.password;
      return jsonFetchHelper({ success: true, message: '' });
    }
    if (url.includes('/api/user/manage')) {
      return jsonFetchHelper({ success: true });
    }
    if (url.includes('/api/user/login')) {
      const payload = JSON.parse(rawBody) as { username: string; password: string };
      if (platformPasswords[payload.username] === payload.password) {
        return jsonFetchHelper({
          success: true,
          data: { access_token: 'user-jwt-7' },
        });
      }
      return jsonFetchHelper({
        success: false,
        message: 'Username or password is incorrect, or user has been banned',
      });
    }
    throw new Error(`unrouted: ${url}`);
  };

  return {
    fetchMock: fetchMock as unknown as typeof fetch,
    getSavedApiKey: () => savedApiKey,
    getSavedSyncedPassword: () => savedSyncedPassword,
    getPlatformPassword: () => platformPasswords['zhangsan'],
  };
}

test('复现：平台用户已存在且本地无存密码 → 必须先同步密码再登录建key', async () => {
  const sim = createPlatformSimMock({
    platformPassword: 'PlatformOldPwd1',
    storedDbPassword: null,
  });

  const result = await getOrCreateApiKey(
    SUPABASE_URL,
    SRK,
    'user-1',
    'zhangsan',
    { fetch: sim.fetchMock, generatePassword: () => 'GenPass456!' }
  );

  assert.match(result.apikey, /^sk-[0-9a-f]{48}$/);
  assert.equal(sim.getSavedSyncedPassword(), sim.getPlatformPassword());
  assert.equal(sim.getSavedApiKey(), result.apikey);
});

test('复现：库中残留与平台不一致的脏密码 → 应重新生成并同步后自愈', async () => {
  const sim = createPlatformSimMock({
    platformPassword: 'PlatformOldPwd1',
    storedDbPassword: 'StaleWrongPwd99',
  });

  const result = await getOrCreateApiKey(
    SUPABASE_URL,
    SRK,
    'user-1',
    'zhangsan',
    { fetch: sim.fetchMock, generatePassword: () => 'GenPass789!' }
  );

  assert.match(result.apikey, /^sk-[0-9a-f]{48}$/);
  assert.equal(sim.getSavedSyncedPassword(), sim.getPlatformPassword());
});

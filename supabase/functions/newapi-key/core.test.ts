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
    if (url.includes('/api/token/') && method === 'POST') {
      return {
        status: 200,
        body: { success: true, message: '', data: { items: [{ key: 'sk-new-token' }] } },
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
  assert.equal(result.apikey, 'sk-new-token');

  // 断言调用了建用户、设额度、登录、建令牌
  const userCreate = calls.find((u) => u.endsWith('/api/user/'));
  assert.ok(userCreate, '应调用创建用户');
  const quotaCall = calls.find((u) => u.includes('/api/user/manage'));
  assert.ok(quotaCall, '应调用设额度');
  assert.ok(calls.some((u) => u.includes('/api/user/login')), '应调用登录');
  assert.ok(calls.some((u) => u.includes('/api/token/')), '应调用建令牌');
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
    if (url.includes('/api/token/') && method === 'POST') {
      return {
        status: 200,
        body: { success: true, message: '', data: { items: [{ key: 'sk-existing-user' }] } },
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
  assert.equal(result.apikey, 'sk-existing-user');
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

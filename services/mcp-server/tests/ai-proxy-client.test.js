import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AiProxyError,
  buildGenerationBody,
  createAiProxyClient,
  parseImageResponseItems,
} from '../src/ai-proxy-client.js';
import { createSupabaseAuth } from '../src/supabase-auth.js';

function jsonResponse(status, body) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  };
}

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

function makeAuth(fetchImpl) {
  return createSupabaseAuth({
    supabaseUrl: 'http://sb.test',
    anonKey: 'anon-key',
    email: 'chen@example.com',
    password: 'pw',
    fetchImpl,
    logger: { warn() {} },
  });
}

function makeConfig(overrides = {}) {
  return {
    supabaseUrl: 'http://sb.test',
    supabaseAnonKey: 'anon-key',
    requestTimeoutMs: 600000,
    ...overrides,
  };
}

const AUTH_OK = {
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 3600,
      user: { id: 'user-1', email: 'chen@example.com' },
    }),
};

test('buildGenerationBody：n=1 省略 / 参考图带 image[] / quality 透传', () => {
  assert.deepEqual(
    buildGenerationBody({ model: 'gpt-image-2', prompt: 'a cat' }),
    { model: 'gpt-image-2', prompt: 'a cat' }
  );
  assert.deepEqual(
    buildGenerationBody({
      model: 'gpt-image-2',
      prompt: 'a cat',
      n: 3,
      size: '1792x1024',
      quality: 'high',
      referenceImages: ['https://ref/1.png'],
    }),
    {
      model: 'gpt-image-2',
      prompt: 'a cat',
      n: 3,
      size: '1792x1024',
      quality: 'high',
      image: ['https://ref/1.png'],
    }
  );
  // n 超上限钳到 10；n≤0 钳到 1（省略字段）
  assert.deepEqual(
    buildGenerationBody({ model: 'm', prompt: 'p', n: 99 }),
    { model: 'm', prompt: 'p', n: 10 }
  );
  assert.deepEqual(
    buildGenerationBody({ model: 'm', prompt: 'p', n: 0 }),
    { model: 'm', prompt: 'p' }
  );
});

test('parseImageResponseItems：url / b64 / 违禁内容 / 无图 / 空', () => {
  assert.deepEqual(
    parseImageResponseItems({ data: [{ url: 'https://up/1.png' }] }),
    [{ kind: 'url', url: 'https://up/1.png' }]
  );
  // 裸 base64（≥32 字符，命中 JPEG 签名）归一为 data URL
  const jpegB64 = '/9j/' + 'A'.repeat(64);
  assert.deepEqual(
    parseImageResponseItems({ data: [{ url: jpegB64 }] }),
    [{ kind: 'url', url: `data:image/jpeg;base64,${jpegB64}` }]
  );
  assert.deepEqual(
    parseImageResponseItems({ data: [{ b64_json: 'iVBORw0KGgo' }] }),
    [{ kind: 'b64', b64: 'iVBORw0KGgo' }]
  );
  assert.throws(
    () =>
      parseImageResponseItems({
        data: [{ revised_prompt: 'PROHIBITED_CONTENT: xxx' }],
      }),
    (e) => e instanceof AiProxyError && e.code === 'prohibited_content'
  );
  assert.throws(
    () => parseImageResponseItems({ data: [{ revised_prompt: 'NO_IMAGE' }] }),
    (e) => e instanceof AiProxyError && e.code === 'no_image'
  );
  assert.throws(
    () => parseImageResponseItems({ data: [] }),
    (e) => e instanceof AiProxyError && e.code === 'empty_response'
  );
  assert.throws(
    () => parseImageResponseItems({}),
    (e) => e instanceof AiProxyError && e.code === 'empty_response'
  );
});

test('generateImage：POST JSON + x-task-id 透传 + Authorization Bearer', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => AUTH_OK],
    ['/ai-proxy/v1/images/generations', () =>
      jsonResponse(200, { data: [{ url: 'https://up/a.png' }] })],
  ]);
  const auth = makeAuth(fetchImpl);
  const client = createAiProxyClient({ auth, config: makeConfig(), fetchImpl });

  const { taskId, response } = await client.generateImage({
    model: 'gpt-image-2',
    prompt: 'a cat',
    size: '1024x1024',
  });
  const call = fetchImpl.calls[1];
  assert.equal(
    call.url,
    'http://sb.test/functions/v1/ai-proxy/v1/images/generations'
  );
  assert.ok(call.init.headers.Authorization.startsWith('Bearer '));
  assert.match(call.init.headers['x-task-id'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(call.init.body), {
    model: 'gpt-image-2',
    prompt: 'a cat',
    size: '1024x1024',
  });
  assert.match(taskId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(response, { data: [{ url: 'https://up/a.png' }] });
});

test('generateImage：外部 taskId 预置（台账对齐）', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => AUTH_OK],
    ['/ai-proxy/v1/images/generations', () => jsonResponse(200, { data: [{ url: 'u' }] })],
  ]);
  const auth = makeAuth(fetchImpl);
  const client = createAiProxyClient({ auth, config: makeConfig(), fetchImpl });
  const { taskId } = await client.generateImage({
    model: 'm',
    prompt: 'p',
    taskId: 'fixed-task-id',
  });
  assert.equal(taskId, 'fixed-task-id');
  assert.equal(fetchImpl.calls[1].init.headers['x-task-id'], 'fixed-task-id');
});

test('401 时强制重登并重试一次', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', (_u, _i, seq) =>
      seq === 1 ? AUTH_OK : { ...AUTH_OK, text: async () => JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, user: { id: 'user-1' } }) }],
    ['/ai-proxy/v1/images/generations', (_u, _i, seq) =>
      seq === 2
        ? jsonResponse(401, { error: 'unauthorized' })
        : jsonResponse(200, { data: [{ url: 'https://up/a.png' }] })],
  ]);
  const auth = makeAuth(fetchImpl);
  const client = createAiProxyClient({ auth, config: makeConfig(), fetchImpl });
  const { response } = await client.generateImage({ model: 'm', prompt: 'p' });
  assert.deepEqual(response, { data: [{ url: 'https://up/a.png' }] });
  // 调用序：登录 → 401 → 重登 → 重试成功
  assert.equal(fetchImpl.calls.length, 4);
  assert.equal(fetchImpl.calls[3].init.headers.Authorization, 'Bearer at-2');
});

test('配额超限映射为 quota_exceeded', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => AUTH_OK],
    ['/ai-proxy/v1/images/generations', () =>
      jsonResponse(403, { error: 'quota_exceeded', message: 'quota exceeded' })],
  ]);
  const auth = makeAuth(fetchImpl);
  const client = createAiProxyClient({ auth, config: makeConfig(), fetchImpl });
  await assert.rejects(
    () => client.generateImage({ model: 'm', prompt: 'p' }),
    (e) => e instanceof AiProxyError && e.code === 'quota_exceeded' && e.status === 403
  );
});

test('getQuota：GET /quota 返回 quota 对象', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => AUTH_OK],
    ['/ai-proxy/quota', () =>
      jsonResponse(200, { quota: { limit: 200, used: 12, remaining: 188, period: '2026-11' } })],
  ]);
  const auth = makeAuth(fetchImpl);
  const client = createAiProxyClient({ auth, config: makeConfig(), fetchImpl });
  const quota = await client.getQuota();
  assert.deepEqual(quota, { limit: 200, used: 12, remaining: 188, period: '2026-11' });
  assert.equal(fetchImpl.calls[1].init.method, 'GET');
  assert.equal(fetchImpl.calls[1].url, 'http://sb.test/functions/v1/ai-proxy/quota');
});

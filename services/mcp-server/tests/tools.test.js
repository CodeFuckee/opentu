import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAiProxyClient } from '../src/ai-proxy-client.js';
import { createMediaStore } from '../src/media-store.js';
import { createSupabaseAuth } from '../src/supabase-auth.js';
import { createMcpServer } from '../src/tools.js';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 7),
]);

function jsonResponse(status, body) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function pngResponse() {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => Uint8Array.from(PNG_BYTES).buffer,
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

const AUTH_OK = () =>
  jsonResponse(200, {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expires_in: 3600,
    user: { id: 'user-1', email: 'chen@example.com' },
  });

const GEN_OK = (n = 1) =>
  jsonResponse(
    200,
    {
      data: Array.from({ length: n }, () => ({ url: 'https://up/a.png' })),
    }
  );

/** 全链路 mock：登录 → 生图 → 上游下载 → 桶上传 → 台账 */
function happyFetch({ genCount = 1 } = {}) {
  return createMockFetch([
    ['/auth/v1/token', () => AUTH_OK()],
    ['/ai-proxy/v1/images/generations', () => GEN_OK(genCount)],
    ['https://up/a.png', () => pngResponse()],
    ['/storage/v1/object/ai-outputs/', () => jsonResponse(200, {})],
    ['/rest/v1/task_submissions', () => jsonResponse(201, [])],
    ['/rest/v1/model_catalog', () =>
      jsonResponse(200, [
        { id: 'gpt-image-2', vendor: 'OPENAI', label: 'GPT Image 2', description: '默认生图模型', is_vip: false, recommended_score: 100 },
        { id: 'seedream-4.0', vendor: 'BYTEPLUS', label: 'Seedream 4.0', is_vip: true, recommended_score: 90 },
        { id: 'gemini-3-pro-image-preview-2k-async', vendor: 'GOOGLE', label: 'Gemini 异步 2K', is_vip: false, recommended_score: 80 },
      ])],
    ['/ai-proxy/quota', () =>
      jsonResponse(200, { quota: { limit: 200, used: 3, remaining: 197, period: '2026-11' } })],
  ]);
}

async function makeServer(fetchImpl, configOverrides = {}) {
  const config = {
    supabaseUrl: 'http://sb.test',
    supabaseAnonKey: 'anon-key',
    supabaseEmail: 'chen@example.com',
    defaultModel: 'gpt-image-2',
    requestTimeoutMs: 600000,
    ...configOverrides,
  };
  const auth = createSupabaseAuth({
    supabaseUrl: config.supabaseUrl,
    anonKey: config.supabaseAnonKey,
    email: 'chen@example.com',
    password: 'pw',
    fetchImpl,
    logger: { warn() {} },
  });
  const client = createAiProxyClient({ auth, config, fetchImpl, logger: { warn() {} } });
  const store = createMediaStore({
    auth,
    config,
    fetchImpl,
    sleepImpl: async () => {},
    logger: { warn() {} },
  });
  const server = createMcpServer({ config, auth, client, store, fetchImpl, logger: { warn() {} } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return { server, mcpClient, fetchImpl };
}

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

test('协议握手与工具清单', async () => {
  const { mcpClient } = await makeServer(happyFetch());
  const tools = await mcpClient.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['check_quota', 'generate_image', 'list_models']);
});

test('generate_image 文生图全链路：稳定直链 + 台账 submitted→completed', async () => {
  const fetchImpl = happyFetch();
  const { mcpClient } = await makeServer(fetchImpl);
  const result = await mcpClient.callTool({
    name: 'generate_image',
    arguments: { prompt: 'a cat in the rain', size: '16x9' },
  });
  assert.equal(result.isError, undefined);
  const payload = parseText(result);
  assert.equal(payload.success, true);
  assert.equal(payload.model, 'gpt-image-2');
  assert.equal(payload.count, 1);
  assert.ok(payload.images[0].url.includes('/object/public/ai-outputs/chen/'));
  assert.equal(payload.images[0].archived, true);
  assert.equal(payload.images[0].source_url, 'https://up/a.png');

  // 登录请求：apikey 头与账密体必须真实携带（守护 server→auth 键名映射，
  // 防止 undefined 凭据退化成网关 401——2026-11-05 部署实证的缺陷）
  const authCall = fetchImpl.calls.find((c) => c.url.includes('/auth/v1/token'));
  assert.equal(authCall.init.headers.apikey, 'anon-key');
  assert.deepEqual(JSON.parse(authCall.init.body), {
    email: 'chen@example.com',
    password: 'pw',
  });

  // 生图请求体：16x9 → 1792x1024
  const genCall = fetchImpl.calls.find((c) => c.url.includes('/images/generations'));
  assert.deepEqual(JSON.parse(genCall.init.body), {
    model: 'gpt-image-2',
    prompt: 'a cat in the rain',
    size: '1792x1024',
  });

  // 台账两次 upsert：submitted + completed，同一 task_id，x-task-id 对齐
  const archiveCalls = fetchImpl.calls.filter((c) => c.url.includes('task_submissions'));
  assert.equal(archiveCalls.length, 2);
  const submitted = JSON.parse(archiveCalls[0].init.body);
  const completed = JSON.parse(archiveCalls[1].init.body);
  assert.equal(submitted.status, 'submitted');
  assert.equal(completed.status, 'completed');
  assert.equal(submitted.task_id, completed.task_id);
  // params 列 NOT NULL：终态 upsert 必须带 params（缺列会 23502，行卡 submitted）
  assert.deepEqual(completed.params, {
    prompt: 'a cat in the rain',
    model: 'gpt-image-2',
    size: '1792x1024',
    n: 1,
    referenceImages: [],
  });
  const genTaskId = genCall.init.headers['x-task-id'];
  assert.equal(submitted.task_id, genTaskId);
  assert.ok(completed.result.url.includes('/object/public/ai-outputs/'));
  assert.ok(completed.completed_at);
});

test('generate_image 图生图：reference_images 进 image[]', async () => {
  const fetchImpl = happyFetch({ genCount: 2 });
  const { mcpClient } = await makeServer(fetchImpl);
  const result = await mcpClient.callTool({
    name: 'generate_image',
    arguments: {
      prompt: 'watercolor style',
      reference_images: ['https://ref/1.png', 'data:image/png;base64,AAA'],
      n: 2,
    },
  });
  const payload = parseText(result);
  assert.equal(payload.count, 2);
  const genCall = fetchImpl.calls.find((c) => c.url.includes('/images/generations'));
  const body = JSON.parse(genCall.init.body);
  assert.deepEqual(body.image, ['https://ref/1.png', 'data:image/png;base64,AAA']);
  assert.equal(body.n, 2);
});

test('generate_image return_base64：附 image content block', async () => {
  const { mcpClient } = await makeServer(happyFetch());
  const result = await mcpClient.callTool({
    name: 'generate_image',
    arguments: { prompt: 'a cat', return_base64: true },
  });
  const imageBlock = result.content.find((c) => c.type === 'image');
  assert.ok(imageBlock);
  assert.equal(imageBlock.mimeType, 'image/png');
  assert.equal(
    Buffer.from(imageBlock.data, 'base64').compare(PNG_BYTES),
    0
  );
});

test('generate_image 配额超限：明确报错 + 台账 failed', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => AUTH_OK()],
    ['/ai-proxy/v1/images/generations', () =>
      jsonResponse(403, { error: 'quota_exceeded', message: 'quota exceeded' })],
    ['/rest/v1/task_submissions', () => jsonResponse(201, [])],
  ]);
  const { mcpClient, fetchImpl: calls } = await makeServer(fetchImpl);
  const result = await mcpClient.callTool({
    name: 'generate_image',
    arguments: { prompt: 'a cat' },
  });
  assert.equal(result.isError, true);
  const payload = parseText(result);
  assert.equal(payload.success, false);
  assert.ok(payload.error.includes('配额已用尽'));
  const archiveCalls = calls.calls.filter((c) => c.url.includes('task_submissions'));
  assert.equal(archiveCalls.length, 2);
  const failed = JSON.parse(archiveCalls[1].init.body);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'quota_exceeded');
});

test('generate_image 异步模型拒绝：不发上游请求、不耗配额', async () => {
  const fetchImpl = happyFetch();
  const { mcpClient } = await makeServer(fetchImpl);
  const result = await mcpClient.callTool({
    name: 'generate_image',
    arguments: { prompt: 'a cat', model: 'gemini-3-pro-image-preview-2k-async' },
  });
  assert.equal(result.isError, true);
  const payload = parseText(result);
  assert.equal(payload.code, 'async_model_unsupported');
  assert.ok(payload.error.includes('同步模型'));
  // 只有登录请求，无生图请求
  assert.equal(
    fetchImpl.calls.some((c) => c.url.includes('/images/generations')),
    false
  );
});

test('generate_image 空提示词拒绝', async () => {
  const { mcpClient } = await makeServer(happyFetch());
  const result = await mcpClient.callTool({
    name: 'generate_image',
    arguments: { prompt: '   ' },
  });
  assert.equal(result.isError, true);
  assert.ok(parseText(result).error.includes('prompt'));
});

test('list_models：过滤异步模型并标注默认', async () => {
  const fetchImpl = happyFetch();
  const { mcpClient } = await makeServer(fetchImpl);
  const result = await mcpClient.callTool({ name: 'list_models', arguments: {} });
  const payload = parseText(result);
  assert.equal(payload.success, true);
  assert.equal(payload.default, 'gpt-image-2');
  assert.deepEqual(
    payload.models.map((m) => m.id),
    ['gpt-image-2', 'seedream-4.0']
  );
  assert.deepEqual(payload.async_unavailable, [
    'gemini-3-pro-image-preview-2k-async',
  ]);
  // anon 读：apikey 头，无 Authorization
  const catalogCall = fetchImpl.calls.find((c) => c.url.includes('model_catalog'));
  assert.equal(catalogCall.init.headers.apikey, 'anon-key');
  assert.equal(catalogCall.init.headers.Authorization, undefined);
});

test('check_quota：透传配额对象', async () => {
  const { mcpClient } = await makeServer(happyFetch());
  const result = await mcpClient.callTool({ name: 'check_quota', arguments: {} });
  const payload = parseText(result);
  assert.deepEqual(payload.quota, {
    limit: 200,
    used: 3,
    remaining: 197,
    period: '2026-11',
  });
});

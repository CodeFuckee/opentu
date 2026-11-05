import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaStore } from '../src/media-store.js';
import { createSupabaseAuth } from '../src/supabase-auth.js';
import { sha256Hex } from '../src/util.js';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 7),
]);

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

function makeStore(fetchImpl, overrides = {}) {
  const auth = overrides.auth || makeAuth(fetchImpl);
  const store = createMediaStore({
    auth,
    config: { supabaseUrl: 'http://sb.test', supabaseAnonKey: 'anon-key' },
    fetchImpl,
    sleepImpl: async () => {},
    nowFn: () => new Date(2026, 10, 5).getTime(),
    logger: { warn() {} },
  });
  return { store, auth };
}

test('downloadImageBytes：成功返回字节与 mime', async () => {
  const fetchImpl = createMockFetch([
    ['https://up/a.png', () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from(PNG_BYTES).buffer,
    })],
  ]);
  const { store } = makeStore(fetchImpl);
  const result = await store.downloadImageBytes('https://up/a.png');
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/png');
  assert.equal(fetchImpl.calls[0].init.headers['User-Agent'].includes('Mozilla'), true);
});

test('downloadImageBytes：失败重试后成功（4 次上限，退避）', async () => {
  let upstreamCalls = 0;
  const fetchImpl = createMockFetch([
    ['https://up/flaky.png', () => {
      upstreamCalls += 1;
      if (upstreamCalls < 3) throw new Error('ETIMEDOUT');
      return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(PNG_BYTES).buffer };
    }],
  ]);
  const { store } = makeStore(fetchImpl);
  const result = await store.downloadImageBytes('https://up/flaky.png');
  assert.equal(result.ok, true);
  assert.equal(upstreamCalls, 3);
});

test('downloadImageBytes：重试耗尽 → ok:false（不抛异常）', async () => {
  let calls = 0;
  const fetchImpl = createMockFetch([
    ['https://up/dead.png', () => {
      calls += 1;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('<html>err</html>').buffer };
    }],
  ]);
  const { store } = makeStore(fetchImpl);
  const result = await store.downloadImageBytes('https://up/dead.png');
  assert.equal(result.ok, false);
  assert.match(result.error, /魔数校验失败/);
  assert.equal(calls, 4);
});

test('buildStoragePath：净化用户名 + 日期 + sha256 + 扩展名', () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u1', email: 'chen@example.com' } })],
  ]);
  const { store } = makeStore(fetchImpl);
  const hash = sha256Hex(PNG_BYTES);
  const path = store.buildStoragePath('chen@example.com', hash, 'image/png');
  assert.equal(path, `chen_example.com/2026-11-05/${hash}.png`);

  const pathSpecial = store.buildStoragePath('OA.Chen+K', hash, 'image/jpeg');
  assert.equal(pathSpecial, `oa.chen_k/2026-11-05/${hash}.jpg`);
});

test('uploadToPublicBucket：POST ai-outputs + x-upsert + 稳定直链', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u1', email: 'chen@example.com' } })],
    ['/storage/v1/object/ai-outputs/', () => jsonResponse(200, {})],
  ]);
  const { store } = makeStore(fetchImpl);
  const uploaded = await store.uploadToPublicBucket({
    bytes: PNG_BYTES,
    mime: 'image/png',
    username: 'chen',
  });
  const call = fetchImpl.calls[1];
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-upsert'], 'true');
  assert.equal(call.init.headers['Content-Type'], 'image/png');
  assert.equal(call.init.headers.Authorization, 'Bearer at');
  const hash = sha256Hex(PNG_BYTES);
  assert.ok(call.url.endsWith(`/storage/v1/object/ai-outputs/chen/2026-11-05/${hash}.png`));
  assert.equal(
    uploaded.publicUrl,
    `http://sb.test/storage/v1/object/public/ai-outputs/chen/2026-11-05/${hash}.png`
  );
  assert.equal(uploaded.size, PNG_BYTES.length);
});

test('uploadToPublicBucket：失败抛错（交给交付线回退）', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u1', email: 'chen@example.com' } })],
    ['/storage/v1/object/ai-outputs/', () => jsonResponse(403, { error: 'forbidden' })],
  ]);
  const { store } = makeStore(fetchImpl);
  await assert.rejects(
    () => store.uploadToPublicBucket({ bytes: PNG_BYTES, mime: 'image/png', username: 'chen' }),
    /ai-outputs 上传失败: HTTP 403/
  );
});

test('deliverResults：url 条目归档成功 → 稳定直链 + archived:true', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u1', email: 'chen@example.com' } })],
    ['https://up/a.png', () => ({ ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(PNG_BYTES).buffer })],
    ['/storage/v1/object/ai-outputs/', () => jsonResponse(200, {})],
  ]);
  const { store } = makeStore(fetchImpl);
  const results = await store.deliverResults({
    items: [{ kind: 'url', url: 'https://up/a.png' }],
    username: 'chen',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].archived, true);
  assert.equal(results[0].source_url, 'https://up/a.png');
  assert.ok(results[0].url.includes('/object/public/ai-outputs/'));
  assert.equal(results[0].format, 'png');
  assert.equal(results[0].size, PNG_BYTES.length);
});

test('deliverResults：下载失败回退原始 URL + archived:false（不阻塞交付）', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u1', email: 'chen@example.com' } })],
    ['https://up/dead.png', () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('<html>err</html>').buffer })],
  ]);
  const { store } = makeStore(fetchImpl);
  const results = await store.deliverResults({
    items: [{ kind: 'url', url: 'https://up/dead.png' }],
    username: 'chen',
  });
  assert.equal(results[0].archived, false);
  assert.equal(results[0].url, 'https://up/dead.png');
});

test('deliverResults：b64 条目解码后走同一上传路径', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u1', email: 'chen@example.com' } })],
    ['/storage/v1/object/ai-outputs/', () => jsonResponse(200, {})],
  ]);
  const { store } = makeStore(fetchImpl);
  const results = await store.deliverResults({
    items: [{ kind: 'b64', b64: PNG_BYTES.toString('base64') }],
    username: 'chen',
    wantBase64: true,
  });
  assert.equal(results[0].archived, true);
  assert.equal(results[0].format, 'png');
  assert.ok(results[0].base64.length > 0);
  // 上传的字节与解码一致
  const uploadCall = fetchImpl.calls[1];
  assert.equal(Buffer.from(uploadCall.init.body).compare(PNG_BYTES), 0);
});

test('upsertTaskSubmission：on_conflict + Prefer + 载荷完整；失败不抛', async () => {
  const bodies = [];
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u1', email: 'chen@example.com' } })],
    ['/rest/v1/task_submissions', (url, init) => {
      bodies.push({ url, init, body: JSON.parse(init.body) });
      return bodies.length === 1
        ? jsonResponse(409, { message: 'conflict' })
        : jsonResponse(201, []);
    }],
  ]);
  const { store } = makeStore(fetchImpl);
  // 第一次失败（409）不抛异常
  await store.upsertTaskSubmission({
    taskId: 't-1',
    userId: 'u1',
    status: 'submitted',
    params: { prompt: 'p' },
  });
  await store.upsertTaskSubmission({
    taskId: 't-1',
    userId: 'u1',
    status: 'completed',
    result: { url: 'http://x/y.png' },
    completedAt: new Date(2026, 10, 5, 12, 0, 0).getTime(),
  });
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].url.includes('on_conflict=user_id,task_id'));
  assert.equal(bodies[0].init.headers.Prefer, 'resolution=merge-duplicates,return=representation');
  assert.deepEqual(bodies[0].body, {
    user_id: 'u1',
    task_id: 't-1',
    type: 'image',
    status: 'submitted',
    params: { prompt: 'p' },
  });
  assert.equal(bodies[1].body.status, 'completed');
  assert.equal(bodies[1].body.completed_at, '2026-11-05T04:00:00.000Z'); // UTC+8 → 04:00Z
});

test('getStorageUsername：取会话邮箱前缀并净化', async () => {
  const fetchImpl = createMockFetch([
    ['/auth/v1/token', () => jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u1', email: 'OA.Chen@example.com' } })],
  ]);
  const { store } = makeStore(fetchImpl);
  assert.equal(await store.getStorageUsername(), 'oa.chen');
});

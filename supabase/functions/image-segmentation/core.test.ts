/**
 * image-segmentation 单元测试(node:test,纯逻辑,mock fetch)。
 * 覆盖:方法/CORS、JWT 鉴权、三 action 请求体校验(点数/坐标/labels/box/
 * sessionId/imageB64 上限)、上游透传(200/4xx 原样/5xx→502)、
 * 上游不可达/超时→502。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleImageSegmentation, parseSegmentRequest } from './core.ts';

const ENV = {
  supabaseUrl: 'http://sb:8000',
  anonKey: 'anon-key-test',
  segmentServiceUrl: 'http://seg:8300',
};
const VALID_JWT = 'header.payload.sig';

function makeAuthedRequest(body: unknown, method = 'POST') {
  return new Request('http://fn/image-segmentation', {
    method,
    headers: { Authorization: `Bearer ${VALID_JWT}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

/** mock fetch:auth 校验与 segment-server 均可编程控制 */
function makeDeps(
  overrides: {
    authOk?: boolean;
    upstreamStatus?: number;
    upstreamBody?: unknown;
    upstreamThrows?: boolean;
  } = {}
) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    calls.push({
      url: u,
      method: init?.method || 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (u.includes('/auth/v1/user')) {
      return new Response(overrides.authOk === false ? 'unauth' : '{"id":"u-1"}', {
        status: overrides.authOk === false ? 401 : 200,
      });
    }
    if (u.startsWith(ENV.segmentServiceUrl!)) {
      if (overrides.upstreamThrows) {
        throw new Error('connect timeout');
      }
      return new Response(JSON.stringify(overrides.upstreamBody ?? { ok: true }), {
        status: overrides.upstreamStatus ?? 200,
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

test('OPTIONS 返回 204 CORS 预检', async () => {
  const res = await handleImageSegmentation(new Request('http://fn/', { method: 'OPTIONS' }), ENV);
  assert.equal(res.status, 204);
});

test('GET 拒绝 405', async () => {
  const res = await handleImageSegmentation(new Request('http://fn/'), ENV);
  assert.equal(res.status, 405);
});

test('缺 JWT 401', async () => {
  const res = await handleImageSegmentation(
    new Request('http://fn/', { method: 'POST', body: '{}' }),
    ENV
  );
  assert.equal(res.status, 401);
});

test('无效 JWT 401(不透传上游)', async () => {
  const deps = makeDeps({ authOk: false });
  const res = await handleImageSegmentation(makeAuthedRequest({ action: 'health' }), ENV, deps);
  assert.equal(res.status, 401);
  assert.ok(deps.calls.every((c) => !c.url.includes('seg:8300')));
});

test('encode 合法请求透传且只带 imageB64', async () => {
  const deps = makeDeps({
    upstreamBody: { sessionId: 's-1', width: 1024, height: 768, device: 'cuda', encodeMs: 300 },
  });
  const res = await handleImageSegmentation(
    makeAuthedRequest({ action: 'encode', imageB64: 'aGVsbG8=' }),
    ENV,
    deps
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sessionId, 's-1');
  const upstream = deps.calls.find((c) => c.url.endsWith('/encode'));
  assert.ok(upstream);
  assert.deepEqual(Object.keys(upstream.body), ['imageB64']);
});

test('segment 合法请求透传 points/labels/box', async () => {
  const deps = makeDeps({
    upstreamBody: { maskPngB64: 'x', score: 0.9, maskWidth: 10, maskHeight: 10, decodeMs: 50 },
  });
  const res = await handleImageSegmentation(
    makeAuthedRequest({
      action: 'segment',
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      points: [[10, 20], [30, 40]],
      labels: [1, 0],
      box: [0, 0, 100, 100],
    }),
    ENV,
    deps
  );
  assert.equal(res.status, 200);
  const upstream = deps.calls.find((c) => c.url.endsWith('/segment'));
  assert.deepEqual(upstream?.body, {
    sessionId: '01234567-89ab-cdef-0123-456789abcdef',
    points: [[10, 20], [30, 40]],
    labels: [1, 0],
    box: [0, 0, 100, 100],
  });
});

test('health 走 GET /health', async () => {
  const deps = makeDeps({ upstreamBody: { status: 'ok', device: 'cuda' } });
  const res = await handleImageSegmentation(makeAuthedRequest({ action: 'health' }), ENV, deps);
  assert.equal(res.status, 200);
  const upstream = deps.calls.find((c) => c.url.endsWith('/health'));
  assert.equal(upstream?.method, 'GET');
});

test('上游 404(会话过期)原样透传', async () => {
  const deps = makeDeps({ upstreamStatus: 404, upstreamBody: { error: 'session_not_found' } });
  const res = await handleImageSegmentation(
    makeAuthedRequest({
      action: 'segment',
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      points: [[1, 1]],
      labels: [1],
    }),
    ENV,
    deps
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'session_not_found');
});

test('上游 500 统一 502', async () => {
  const deps = makeDeps({ upstreamStatus: 500, upstreamBody: 'boom' });
  const res = await handleImageSegmentation(
    makeAuthedRequest({ action: 'encode', imageB64: 'aGVsbG8=' }),
    ENV,
    deps
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_error');
});

test('上游不可达 → 502 segment_service_unavailable', async () => {
  const deps = makeDeps({ upstreamThrows: true });
  const res = await handleImageSegmentation(
    makeAuthedRequest({ action: 'encode', imageB64: 'aGVsbG8=' }),
    ENV,
    deps
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'segment_service_unavailable');
});

test('非法请求体 400(逐项)', async () => {
  const cases: unknown[] = [
    {},
    { action: 'unknown' },
    { action: 'encode' },
    { action: 'encode', imageB64: '' },
    { action: 'encode', imageB64: 123 },
    { action: 'segment' },
    { action: 'segment', sessionId: 'not-uuid', points: [[1, 1]], labels: [1] },
    { action: 'segment', sessionId: '01234567-89ab-cdef-0123-456789abcdef', points: [], labels: [] },
    {
      action: 'segment',
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      points: [[1, 1]],
      labels: [],
    },
    {
      action: 'segment',
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      points: [[1, 1]],
      labels: [2],
    },
    {
      action: 'segment',
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      points: [[1.5, 1]],
      labels: [1],
    },
    {
      action: 'segment',
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      points: [[-1, 1]],
      labels: [1],
    },
    {
      action: 'segment',
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      points: Array.from({ length: 17 }, () => [1, 1]),
      labels: Array.from({ length: 17 }, () => 1),
    },
    {
      action: 'segment',
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      points: [[1, 1]],
      labels: [1],
      box: [10, 10, 10, 20],
    },
  ];
  const deps = makeDeps();
  for (const body of cases) {
    const res = await handleImageSegmentation(makeAuthedRequest(body), ENV, deps);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('parseSegmentRequest:imageB64 超限拒绝', () => {
  const huge = 'a'.repeat(8_000_001);
  assert.equal(parseSegmentRequest({ action: 'encode', imageB64: huge }), null);
});

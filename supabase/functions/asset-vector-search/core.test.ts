/**
 * asset-vector-search 单元测试(node:test,纯逻辑不依赖真实 Supabase)。
 * 覆盖:方法/CORS、JWT 鉴权、请求体校验(维度/类型/assetTypes 白名单/topK 钳制)、
 * RPC 透传形态与错误映射、结果 camelCase 转换。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleAssetVectorSearch,
  parseSearchRequest,
  mapRpcRow,
  EMBEDDING_DIM,
} from './core.ts';

const ENV = { supabaseUrl: 'http://sb:8000', anonKey: 'anon-key-test' };
const VALID_JWT = 'header.payload.sig';

function makeEmbedding(value = 0.01) {
  return Array(EMBEDDING_DIM).fill(value) as number[];
}

function makeAuthedRequest(body: unknown, method = 'POST') {
  return new Request('http://fn/asset-vector-search', {
    method,
    headers: { Authorization: `Bearer ${VALID_JWT}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

/** mock fetch:auth 校验 + rpc 均可编程控制 */
function makeDeps(overrides: { authOk?: boolean; rpcStatus?: number; rpcRows?: unknown } = {}) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) {
      return new Response(overrides.authOk === false ? 'unauth' : '{"id":"u-1"}', {
        status: overrides.authOk === false ? 401 : 200,
      });
    }
    if (u.includes('/rest/v1/rpc/search_similar_assets')) {
      calls.push({ url: u, body: JSON.parse(String(init?.body || '{}')) });
      if (overrides.rpcStatus && overrides.rpcStatus !== 200) {
        return new Response('rpc err', { status: overrides.rpcStatus });
      }
      return new Response(
        JSON.stringify(
          overrides.rpcRows ?? [
            {
              asset_type: 'jzxz_materials',
              asset_id: 's1',
              image_url: 'http://sb/img/1.png',
              name: '树',
              category: '植物',
              similarity: 0.93,
            },
          ]
        ),
        { status: 200 }
      );
    }
    return new Response('not found', { status: 404 });
  };
  return { deps: { fetch: fetchMock as unknown as typeof fetch }, calls };
}

test('OPTIONS 预检 204', async () => {
  const res = await handleAssetVectorSearch(
    new Request('http://fn/', { method: 'OPTIONS' }),
    ENV
  );
  assert.equal(res.status, 204);
});

test('非 POST 405', async () => {
  const res = await handleAssetVectorSearch(
    new Request('http://fn/', { method: 'GET' }),
    ENV
  );
  assert.equal(res.status, 405);
});

test('缺/错 JWT 401', async () => {
  const noAuth = await handleAssetVectorSearch(
    new Request('http://fn/', { method: 'POST', body: '{}' }),
    ENV
  );
  assert.equal(noAuth.status, 401);
  const { deps } = makeDeps({ authOk: false });
  const badAuth = await handleAssetVectorSearch(makeAuthedRequest({}), ENV, deps);
  assert.equal(badAuth.status, 401);
});

test('请求体校验:维度/数值/assetTypes 白名单', () => {
  assert.equal(parseSearchRequest(null), null);
  assert.equal(parseSearchRequest({ embedding: [0.1] }), null);
  assert.equal(
    parseSearchRequest({ embedding: makeEmbedding().concat([0.5]) }),
    null
  );
  assert.equal(
    parseSearchRequest({ embedding: makeEmbedding(NaN) }),
    null
  );
  assert.equal(
    parseSearchRequest({
      embedding: makeEmbedding(),
      assetTypes: ['pg_tables'],
    }),
    null
  );
  const ok = parseSearchRequest({
    embedding: makeEmbedding(),
    assetTypes: ['ai_templates'],
    topK: 999,
  });
  assert.ok(ok);
  assert.deepEqual(ok!.assetTypes, ['ai_templates']);
  assert.equal(ok!.topK, 50); // 钳制
  assert.equal(parseSearchRequest({ embedding: makeEmbedding() })!.topK, 30); // 缺省
});

test('合法请求:透传用户 JWT 调 RPC,结果转 camelCase', async () => {
  const { deps, calls } = makeDeps();
  const res = await handleAssetVectorSearch(
    makeAuthedRequest({ embedding: makeEmbedding(), topK: 10 }),
    ENV,
    deps
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { results: Array<Record<string, unknown>> };
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0]!.assetType, 'jzxz_materials');
  assert.equal(body.results[0]!.similarity, 0.93);
  // RPC 载荷:向量 + match_count;无 assetTypes 时不下发该参数
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.body as Record<string, unknown>).p_match_count, 10);
  assert.equal((calls[0]!.body as Record<string, unknown>).p_asset_types, undefined);
  assert.ok((calls[0]!.body as Record<string, unknown>).p_embedding);
});

test('RPC 失败 502;坏载荷 502', async () => {
  const fail = makeDeps({ rpcStatus: 500 });
  const res1 = await handleAssetVectorSearch(
    makeAuthedRequest({ embedding: makeEmbedding() }),
    ENV,
    fail.deps
  );
  assert.equal(res1.status, 502);

  const bad = makeDeps({ rpcRows: { not: 'array' } });
  const res2 = await handleAssetVectorSearch(
    makeAuthedRequest({ embedding: makeEmbedding() }),
    ENV,
    bad.deps
  );
  assert.equal(res2.status, 502);
});

test('mapRpcRow:name/category 缺失容 null', () => {
  const r = mapRpcRow({ asset_type: 'ai_templates', asset_id: 't1', image_url: 'u', similarity: 0.5 });
  assert.equal(r.name, null);
  assert.equal(r.category, null);
  assert.equal(r.similarity, 0.5);
});

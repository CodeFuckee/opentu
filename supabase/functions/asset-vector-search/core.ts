/**
 * Edge Function: asset-vector-search (core)
 *
 * 以图搜图(#61)检索入口:浏览器端 CLIP 编码出 512 维向量后 POST 本函数,
 * 转发 PostgREST RPC search_similar_assets(pgvector 余弦 top-k + 按素材去重
 * + join 原表元数据),返回相似素材列表。
 *
 * 鉴权:有效用户 JWT 即可(所有登录用户可用,非管理员功能);RPC 调用透传
 * 用户 JWT,asset_vectors 的 RLS(select authenticated)天然生效,本函数
 * 不持有 service_role。
 *
 * POST /functions/v1/asset-vector-search
 *   Authorization: Bearer <用户 Supabase JWT>
 *   { "embedding": number[512], "assetTypes"?: string[], "topK"?: number }
 * → { "results": [{ assetType, assetId, imageUrl, name, category, similarity }] }
 */

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** 允许检索的库(防任意表名注入 PostgREST 过滤) */
export const ALLOWED_ASSET_TYPES = new Set([
  'jzxz_materials',
  'jzxz_home_materials',
  'jzxz_plant_materials',
  'ai_templates',
]);

export const EMBEDDING_DIM = 512;
const TOP_K_MAX = 50;
const TOP_K_DEFAULT = 30;

export interface AssetVectorSearchEnv {
  supabaseUrl: string;
  /** GoTrue 校验要求的 apikey 头(anon key 即可;函数不持有 service_role) */
  anonKey: string;
}

export interface Deps {
  fetch?: typeof fetch;
}

export interface SimilarAssetResult {
  assetType: string;
  assetId: string;
  imageUrl: string;
  name: string | null;
  category: string | null;
  similarity: number;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export function extractBearerToken(headerValue: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(headerValue || '');
  return match ? match[1].trim() : null;
}

/** 校验并规范化请求体;非法返回 null(由调用方回 400) */
export function parseSearchRequest(
  body: unknown
): { embedding: number[]; assetTypes: string[] | null; topK: number } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const { embedding, assetTypes, topK } = body as Record<string, unknown>;
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
    return null;
  }
  for (const v of embedding) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return null;
    }
  }
  let types: string[] | null = null;
  if (assetTypes !== undefined && assetTypes !== null) {
    if (!Array.isArray(assetTypes) || assetTypes.length === 0) {
      return null;
    }
    if (!assetTypes.every((t) => typeof t === 'string' && ALLOWED_ASSET_TYPES.has(t))) {
      return null;
    }
    types = assetTypes as string[];
  }
  let k = TOP_K_DEFAULT;
  if (topK !== undefined) {
    if (typeof topK !== 'number' || !Number.isFinite(topK) || topK < 1) {
      return null;
    }
    k = Math.min(Math.round(topK), TOP_K_MAX);
  }
  return { embedding, assetTypes: types, topK: k };
}

/** RPC snake_case 行 → 前端 camelCase */
export function mapRpcRow(row: Record<string, unknown>): SimilarAssetResult {
  return {
    assetType: String(row.asset_type ?? ''),
    assetId: String(row.asset_id ?? ''),
    imageUrl: String(row.image_url ?? ''),
    name: typeof row.name === 'string' ? row.name : null,
    category: typeof row.category === 'string' ? row.category : null,
    similarity: typeof row.similarity === 'number' ? row.similarity : 0,
  };
}

export async function handleAssetVectorSearch(
  request: Request,
  env: AssetVectorSearchEnv,
  deps: Deps = {}
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = (env.supabaseUrl || '').replace(/\/+$/, '');
  if (!supabaseUrl) {
    return jsonResponse(500, { error: 'SUPABASE_URL is not configured' });
  }
  if (!env.anonKey) {
    return jsonResponse(500, { error: 'SUPABASE_ANON_KEY is not configured' });
  }

  // 登录用户即可(非管理员功能):校验 JWT 有效性(转给 auth 服务验签;
  // GoTrue 要求 apikey 头,anon key 即可)
  const jwt = extractBearerToken(request.headers.get('Authorization'));
  if (!jwt) {
    return jsonResponse(401, { error: 'unauthorized: missing bearer token' });
  }
  const doFetch = deps.fetch || fetch;
  const authCheck = await doFetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: env.anonKey, Authorization: `Bearer ${jwt}` },
  });
  if (!authCheck.ok) {
    return jsonResponse(401, { error: 'unauthorized: invalid token' });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid JSON body' });
  }
  const parsed = parseSearchRequest(body);
  if (!parsed) {
    return jsonResponse(400, {
      error: `invalid request: embedding must be number[${EMBEDDING_DIM}]` +
        (body as { assetTypes?: unknown })?.assetTypes !== undefined
        ? ', assetTypes must be a non-empty subset of known libraries'
        : '',
    });
  }

  // 透传用户 JWT 调 RPC(RLS: asset_vectors select authenticated;
  // PostgREST 同样要求 apikey 头)
  const rpcBody: Record<string, unknown> = {
    p_embedding: parsed.embedding,
    p_match_count: parsed.topK,
  };
  if (parsed.assetTypes) {
    rpcBody.p_asset_types = parsed.assetTypes;
  }
  const rpc = await doFetch(`${supabaseUrl}/rest/v1/rpc/search_similar_assets`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rpcBody),
  });
  if (!rpc.ok) {
    const text = await rpc.text().catch(() => '');
    return jsonResponse(502, {
      error: 'search rpc failed',
      detail: text.slice(0, 200),
    });
  }
  const rows = (await rpc.json().catch(() => null)) as unknown;
  if (!Array.isArray(rows)) {
    return jsonResponse(502, { error: 'search rpc returned unexpected payload' });
  }
  const results = (rows as Record<string, unknown>[]).map(mapRpcRow);
  return jsonResponse(200, { results });
}

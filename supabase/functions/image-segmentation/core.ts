/**
 * Edge Function: image-segmentation (core)
 *
 * 智能抠图推理入口:鉴权后把请求转发给容器网络内的 segment-server
 * (SAM 2.1,GPU)。前端统一走 supabase.functions.invoke,零 CSP 改动;
 * 推理服务不发布端口,本函数是唯一入口。
 *
 * 鉴权:有效用户 JWT 即可(与 asset-vector-search 同模式;GoTrue 校验
 * 要求 apikey 头,anon key 即可,不持有 service_role)。
 *
 * POST /functions/v1/image-segmentation
 *   Authorization: Bearer <用户 Supabase JWT>
 *   { "action": "encode",  "imageB64": "<png/jpeg base64,长边≤1024>" }
 *   { "action": "segment", "sessionId": "<uuid>", "points": [[x,y],..],
 *     "labels": [1|0,..], "box"?: [x1,y1,x2,y2] }
 *   { "action": "health" }
 * → 透传 segment-server 响应:{ sessionId,width,height,device,encodeMs } /
 *   { maskPngB64,score,maskWidth,maskHeight,decodeMs } / { status,model,... }
 */

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_POINTS = 16;
const MAX_COORD = 8191;
const MAX_IMAGE_B64_CHARS = 8_000_000; // 与服务端一致,约 6MB 二进制
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ENCODE_TIMEOUT_MS = 30_000;
const SEGMENT_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;

export interface ImageSegmentationEnv {
  supabaseUrl: string;
  /** GoTrue 校验要求的 apikey 头(anon key 即可) */
  anonKey: string;
  /** segment-server 容器内地址(edge functions 同 docker 网络) */
  segmentServiceUrl?: string;
}

export interface Deps {
  fetch?: typeof fetch;
}

export type SegmentRequest =
  | { action: 'encode'; imageB64: string }
  | {
      action: 'segment';
      sessionId: string;
      points: number[][];
      labels: number[];
      box?: number[];
    }
  | { action: 'health' };

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

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COORD;
}

/** 校验并规范化请求体;非法返回 null(由调用方回 400) */
export function parseSegmentRequest(body: unknown): SegmentRequest | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { action } = body as Record<string, unknown>;
  if (action === 'health') {
    return { action: 'health' };
  }
  if (action === 'encode') {
    const { imageB64 } = body as Record<string, unknown>;
    if (
      typeof imageB64 !== 'string' ||
      imageB64.length === 0 ||
      imageB64.length > MAX_IMAGE_B64_CHARS
    ) {
      return null;
    }
    return { action: 'encode', imageB64 };
  }
  if (action === 'segment') {
    const { sessionId, points, labels, box } = body as Record<string, unknown>;
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
      return null;
    }
    if (!Array.isArray(points) || points.length === 0 || points.length > MAX_POINTS) {
      return null;
    }
    for (const p of points) {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(isInt)) {
        return null;
      }
    }
    if (
      !Array.isArray(labels) ||
      labels.length !== points.length ||
      !labels.every((l) => l === 0 || l === 1)
    ) {
      return null;
    }
    if (box !== undefined && box !== null) {
      if (
        !Array.isArray(box) ||
        box.length !== 4 ||
        !box.every(isInt) ||
        box[2] <= box[0] ||
        box[3] <= box[1]
      ) {
        return null;
      }
    }
    return {
      action: 'segment',
      sessionId,
      points: points as number[][],
      labels: labels as number[],
      ...(Array.isArray(box) ? { box } : {}),
    };
  }
  return null;
}

/** 上游错误透传规则:4xx 客户端问题原样回,5xx/网络错误统一 502 */
async function forwardUpstream(upstream: Response): Promise<Response> {
  if (upstream.ok) {
    const data = await upstream.json().catch(() => null);
    if (data === null) {
      return jsonResponse(502, { error: 'upstream_error', message: '推理服务返回异常负载' });
    }
    return jsonResponse(200, data);
  }
  const text = await upstream.text().catch(() => '');
  if (upstream.status >= 400 && upstream.status < 500) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // 保持 payload 为 null,走统一错误体
    }
    if (payload && typeof payload === 'object' && 'error' in payload) {
      return jsonResponse(upstream.status, payload);
    }
    return jsonResponse(upstream.status, {
      error: 'upstream_error',
      message: text.slice(0, 200),
    });
  }
  return jsonResponse(502, {
    error: 'upstream_error',
    message: `推理服务错误(${upstream.status})`,
    detail: text.slice(0, 200),
  });
}

export async function handleImageSegmentation(
  request: Request,
  env: ImageSegmentationEnv,
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
  const parsed = parseSegmentRequest(body);
  if (!parsed) {
    return jsonResponse(400, {
      error: 'invalid request',
      message:
        '要求 {action: "encode"|"segment"|"health"};encode 需 imageB64;' +
        'segment 需合法 sessionId、≤16 个 0..8191 整数点、一致长度的 0/1 labels、可选合法 box',
    });
  }

  const base = (env.segmentServiceUrl || 'http://segment-server:8300').replace(/\/+$/, '');
  try {
    if (parsed.action === 'health') {
      const upstream = await doFetch(`${base}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return forwardUpstream(upstream);
    }
    if (parsed.action === 'encode') {
      const upstream = await doFetch(`${base}/encode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageB64: parsed.imageB64 }),
        signal: AbortSignal.timeout(ENCODE_TIMEOUT_MS),
      });
      return forwardUpstream(upstream);
    }
    const upstream = await doFetch(`${base}/segment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: parsed.sessionId,
        points: parsed.points,
        labels: parsed.labels,
        ...(parsed.box ? { box: parsed.box } : {}),
      }),
      signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS),
    });
    return forwardUpstream(upstream);
  } catch (e) {
    return jsonResponse(502, {
      error: 'segment_service_unavailable',
      message: e instanceof Error ? e.message : '推理服务不可达',
    });
  }
}

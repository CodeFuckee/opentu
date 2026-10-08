/**
 * 智能抠图推理服务(浏览器侧,#41 智能抠图)。
 *
 * 经 supabase functions.invoke 调 edge function image-segmentation
 * (自动携带用户 JWT),后端为容器内 segment-server(SAM 2.1,GPU)。
 * 纯 HTTP + JSON + PNG,无 secure-context 依赖,内网 HTTP 可用。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SegmentationSession {
  sessionId: string;
  width: number;
  height: number;
  device: string;
  encodeMs: number;
}

export interface SegmentationMask {
  maskPngB64: string;
  score: number;
  maskWidth: number;
  maskHeight: number;
  decodeMs: number;
}

export type SegmentationErrorCode =
  | 'unauthorized'
  | 'session_not_found'
  | 'session_stale'
  | 'bad_request'
  | 'service_unavailable'
  | 'invoke_failed'
  | 'bad_payload';

export class SegmentationError extends Error {
  readonly code: SegmentationErrorCode;
  readonly status: number;

  constructor(message: string, code: SegmentationErrorCode, status = 0) {
    super(message);
    this.name = 'SegmentationError';
    this.code = code;
    this.status = status;
  }
}

type FunctionsClient = Pick<SupabaseClient, 'functions'>;

const KNOWN_CODES: SegmentationErrorCode[] = [
  'unauthorized',
  'session_not_found',
  'session_stale',
  'bad_request',
  'service_unavailable',
];

function classify(status: number, serverCode: unknown): SegmentationErrorCode {
  if (typeof serverCode === 'string' && KNOWN_CODES.includes(serverCode as SegmentationErrorCode)) {
    return serverCode as SegmentationErrorCode;
  }
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'session_not_found';
  if (status === 410) return 'session_stale';
  if (status === 400) return 'bad_request';
  return 'service_unavailable';
}

/**
 * supabase-js 各版本对非 2xx 的返回形态不一:错误体可能在
 * error.context(Response)或 data 里,两者都探测。
 */
async function invokeSegmentation(
  client: FunctionsClient,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await client.functions.invoke('image-segmentation', { body }));
  } catch (e) {
    throw new SegmentationError(
      e instanceof Error ? e.message : '网络请求失败',
      'service_unavailable'
    );
  }
  if (error) {
    let status = 0;
    let payload: { error?: unknown; message?: unknown } = {};
    const ctx = (error as { context?: Response }).context;
    if (ctx instanceof Response) {
      status = ctx.status;
      payload = (await ctx.clone().json().catch(() => ({}))) as typeof payload;
    }
    const message =
      typeof payload.message === 'string'
        ? payload.message
        : error instanceof Error
          ? error.message
          : '抠图服务请求失败';
    throw new SegmentationError(message, classify(status, payload.error), status);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new SegmentationError('抠图服务返回异常负载', 'bad_payload');
  }
  return data as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || !v) {
    throw new SegmentationError(`返回字段 ${key} 缺失`, 'bad_payload');
  }
  return v;
}

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new SegmentationError(`返回字段 ${key} 缺失`, 'bad_payload');
  }
  return v;
}

/** 一次编码:图片(≤1024 长边 JPEG/PNG base64)→ 会话 */
export async function encodeImageForSegmentation(
  client: FunctionsClient,
  imageB64: string
): Promise<SegmentationSession> {
  const data = await invokeSegmentation(client, { action: 'encode', imageB64 });
  return {
    sessionId: requireString(data, 'sessionId'),
    width: requireNumber(data, 'width'),
    height: requireNumber(data, 'height'),
    device: requireString(data, 'device'),
    encodeMs: requireNumber(data, 'encodeMs'),
  };
}

/** 点提示分割:会话 + 点集 → 掩码 PNG(base64,灰度 255=选中) */
export async function segmentWithPoints(
  client: FunctionsClient,
  sessionId: string,
  points: ReadonlyArray<{ x: number; y: number; label: 0 | 1 }>,
  box?: [number, number, number, number]
): Promise<SegmentationMask> {
  if (points.length === 0) {
    throw new SegmentationError('至少需要一个提示点', 'bad_request');
  }
  const data = await invokeSegmentation(client, {
    action: 'segment',
    sessionId,
    points: points.map((p) => [Math.round(p.x), Math.round(p.y)]),
    labels: points.map((p) => p.label),
    ...(box ? { box } : {}),
  });
  return {
    maskPngB64: requireString(data, 'maskPngB64'),
    score: requireNumber(data, 'score'),
    maskWidth: requireNumber(data, 'maskWidth'),
    maskHeight: requireNumber(data, 'maskHeight'),
    decodeMs: requireNumber(data, 'decodeMs'),
  };
}

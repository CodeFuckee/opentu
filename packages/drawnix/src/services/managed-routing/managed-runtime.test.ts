/**
 * managed-runtime 视频模型使用权相关单测
 *
 * 覆盖：
 * - VideoAccessDeniedError 默认文案
 * - parseVideoAccessErrorFromResponse：403 + video_access_denied 识别；
 *   其余状态码/错误类型/非 JSON 一律返回 null
 * - fetchVideoAccess：托管路由未注册抛错；allowed 布尔透传
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureManagedRouting,
  fetchVideoAccess,
  parseVideoAccessErrorFromResponse,
  VideoAccessDeniedError,
} from './managed-runtime';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  configureManagedRouting(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('VideoAccessDeniedError', () => {
  it('默认文案为中文提示', () => {
    const error = new VideoAccessDeniedError();
    expect(error.name).toBe('VideoAccessDeniedError');
    expect(error.message).toContain('视频模型使用权限未开放');
  });

  it('可自定义文案', () => {
    expect(new VideoAccessDeniedError('custom').message).toBe('custom');
  });
});

describe('parseVideoAccessErrorFromResponse', () => {
  it('403 + video_access_denied → 识别为 VideoAccessDeniedError，透传服务端文案', async () => {
    const response = jsonResponse(403, {
      error: 'video_access_denied',
      message: '视频模型使用权限未开放，请联系管理员开通',
    });
    const error = await parseVideoAccessErrorFromResponse(response);
    expect(error).toBeInstanceOf(VideoAccessDeniedError);
    expect(error?.message).toContain('请联系管理员开通');
  });

  it('403 + 其他错误类型 → 返回 null', async () => {
    const response = jsonResponse(403, { error: 'quota_exceeded', remaining: 0 });
    expect(await parseVideoAccessErrorFromResponse(response)).toBeNull();
  });

  it('非 403 状态码 → 返回 null（不读 body）', async () => {
    const response = jsonResponse(503, { error: 'video access service error' });
    expect(await parseVideoAccessErrorFromResponse(response)).toBeNull();
    expect(await parseVideoAccessErrorFromResponse(jsonResponse(200, {}))).toBeNull();
  });

  it('403 + 非 JSON 响应 → 返回 null', async () => {
    const response = new Response('forbidden', { status: 403 });
    expect(await parseVideoAccessErrorFromResponse(response)).toBeNull();
  });
});

describe('fetchVideoAccess', () => {
  it('托管路由未注册 → 抛错', async () => {
    await expect(fetchVideoAccess()).rejects.toThrow('托管路由未启用');
  });

  it('allowed 布尔透传（GET {proxyBase}/video-access，携带 Bearer token）', async () => {
    configureManagedRouting({
      supabaseUrl: 'http://supabase.local:8021',
      getToken: async () => 'jwt-token',
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://supabase.local:8021/functions/v1/ai-proxy/video-access');
      return jsonResponse(200, { allowed: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchVideoAccess()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-token');
  });

  it('allowed=false → false', async () => {
    configureManagedRouting({
      supabaseUrl: 'http://supabase.local:8021',
      getToken: async () => 'jwt-token',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { allowed: false }))
    );
    await expect(fetchVideoAccess()).resolves.toBe(false);
  });

  it('代理非 200 → 抛错（由调用方决定是否兜底放行）', async () => {
    configureManagedRouting({
      supabaseUrl: 'http://supabase.local:8021',
      getToken: async () => 'jwt-token',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(503, { error: 'video access service error' }))
    );
    await expect(fetchVideoAccess()).rejects.toThrow('503');
  });
});

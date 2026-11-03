/**
 * Seedance 视频适配器单测
 *
 * 覆盖：
 * - Seedance 2.5：上游模型名映射为 doubao-seedance-2-5-260628（2.x 无分辨率后缀），
 *   分辨率/比例改走表单 resolution/ratio 字段
 * - Seedance 1.5 回归守卫：仍为 doubao-seedance-1-5-pro_720p 且走 size 字段、
 *   不带 resolution/ratio
 * - 注册表按模型解析：seedance-2.5-pro 路由到 seedance 视频适配器
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerSeedanceAdapter,
  seedanceVideoAdapter,
} from './seedance-adapter';
import { resolveAdapterForModel } from './registry';
import type { AdapterContext } from './types';

const submitResponse = () =>
  new Response(
    JSON.stringify({ id: 'task-1', status: 'queued', created_at: 1 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

const completedResponse = () =>
  new Response(
    JSON.stringify({
      id: 'task-1',
      status: 'completed',
      progress: 100,
      video_url: 'http://video/1.mp4',
      seconds: '5',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

interface CapturedRequest {
  url: string;
  form: FormData | null;
}

function makeContext(captured: CapturedRequest[]): AdapterContext {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/videos')) {
      captured.push({
        url,
        form: init?.body instanceof FormData ? init.body : null,
      });
      return submitResponse();
    }
    return completedResponse();
  }) as unknown as typeof fetch;

  return { baseUrl: 'http://gateway.local', fetcher };
}

describe('seedanceVideoAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'seedance-2.5-pro：映射 doubao-seedance-2-5-260628，分辨率/比例走 resolution/ratio 字段',
    async () => {
      const captured: CapturedRequest[] = [];
      const result = await seedanceVideoAdapter.generateVideo(
        makeContext(captured),
        {
          model: 'seedance-2.5-pro',
          prompt: '一只猫',
          size: '720p@16:9',
          duration: 5,
        }
      );

      expect(result.url).toBe('http://video/1.mp4');
      expect(captured).toHaveLength(1);
      const form = captured[0].form;
      expect(form).not.toBeNull();
      expect(form?.get('model')).toBe('doubao-seedance-2-5-260628');
      expect(form?.get('resolution')).toBe('720p');
      expect(form?.get('ratio')).toBe('16:9');
      expect(form?.get('size')).toBeNull();
      expect(form?.get('seconds')).toBe('5');
    },
    // 轮询循环首个 5s 间隔是真实等待，显式宽松超时不依赖外层 vitest 配置
    30_000
  );

  it(
    'seedance-1.5-pro：仍映射 doubao-seedance-1-5-pro_720p，走 size 字段且不带 resolution/ratio（回归守卫）',
    async () => {
      const captured: CapturedRequest[] = [];
      await seedanceVideoAdapter.generateVideo(makeContext(captured), {
        model: 'seedance-1.5-pro',
        prompt: '一只猫',
        size: '720p@16:9',
        duration: 5,
      });

      const form = captured[0].form;
      expect(form?.get('model')).toBe('doubao-seedance-1-5-pro_720p');
      expect(form?.get('resolution')).toBeNull();
      expect(form?.get('ratio')).toBeNull();
      expect(form?.get('size')).toBe('16:9');
    },
    30_000
  );
});

describe('registry 按模型解析', () => {
  it('seedance-2.5-pro 路由到 seedance 视频适配器', () => {
    registerSeedanceAdapter();
    const adapter = resolveAdapterForModel('seedance-2.5-pro', 'video');
    expect(adapter?.id).toBe('seedance-video-adapter');
  });
});

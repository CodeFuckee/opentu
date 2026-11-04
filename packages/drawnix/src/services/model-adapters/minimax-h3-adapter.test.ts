/**
 * MiniMax H3（本地网关）视频适配器单测
 *
 * 覆盖：
 * - 提交契约：multipart 走 /v1/videos，model 固定 MiniMax-H3，尺寸换算为
 *   「宽x高」（网关只按数字x数字正则解析，720p@16:9 组合串必须先换算）
 * - 轮询契约：completed 取 video_url；failed 抛业务错误
 * - 注册表按模型解析：minimax-h3 路由到 minimax-h3 视频适配器
 *   （注意：adapter 注册非模块级，测试须显式调用注册函数）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeH3Seconds,
  parseSizeToPixels,
  minimaxH3VideoAdapter,
} from './minimax-h3-adapter';
import { registerDefaultModelAdapters } from './default-adapters';
import { clearModelAdapters, resolveAdapterForBinding, resolveAdapterForModel } from './registry';
import type { AdapterContext } from './types';
import type { ProviderModelBinding } from '../provider-routing/types';

const submitResponse = () =>
  new Response(JSON.stringify({ id: 'task-1', status: 'queued' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const completedResponse = () =>
  new Response(
    JSON.stringify({
      id: 'task-1',
      status: 'completed',
      video_url: 'http://gateway.local/v1/videos/task-1/content',
      duration_s: 5.1,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

const failedResponse = () =>
  new Response(
    JSON.stringify({
      id: 'task-1',
      status: 'failed',
      error: { message: 'comfy execution error' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

interface CapturedRequest {
  url: string;
  form: FormData | null;
}

function makeContext(
  captured: CapturedRequest[],
  finalResponse: () => Response = completedResponse
): AdapterContext {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/videos')) {
      captured.push({
        url,
        form: init?.body instanceof FormData ? init.body : null,
      });
      return submitResponse();
    }
    return finalResponse();
  }) as unknown as typeof fetch;

  return { baseUrl: 'http://gateway.local', fetcher };
}

describe('parseSizeToPixels', () => {
  // 720 非整 32，floor 对齐到 704（与网关 _map_size 的 floor 规则一致，所见即所得）
  it('720p@16:9 组合串换算为 1280x704', () => {
    expect(parseSizeToPixels('720p@16:9')).toBe('1280x704');
  });

  it('已是宽x高的值原样透传（网关侧再做对齐与预算缩放）', () => {
    expect(parseSizeToPixels('864x480')).toBe('864x480');
    expect(parseSizeToPixels('864X480')).toBe('864x480');
  });

  it('缺省尺寸回退 720p 16:9', () => {
    expect(parseSizeToPixels(undefined)).toBe('1280x704');
    expect(parseSizeToPixels('')).toBe('1280x704');
  });
});

describe('minimaxH3VideoAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    '提交：POST /v1/videos，model=MiniMax-H3，尺寸换算 1280x704，seconds 传字符串',
    async () => {
      const captured: CapturedRequest[] = [];
      const result = await minimaxH3VideoAdapter.generateVideo(
        makeContext(captured),
        {
          model: 'minimax-h3',
          prompt: '一只猫',
          size: '720p@16:9',
          duration: 5,
        }
      );

      expect(result.url).toBe('http://gateway.local/v1/videos/task-1/content');
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe('http://gateway.local/v1/videos');
      const form = captured[0].form;
      expect(form).not.toBeNull();
      expect(form?.get('model')).toBe('MiniMax-H3');
      expect(form?.get('prompt')).toBe('一只猫');
      expect(form?.get('seconds')).toBe('5');
      expect(form?.get('size')).toBe('1280x704');
    },
    // 轮询循环首个 5s 间隔是真实等待，显式宽松超时不依赖外层 vitest 配置
    30_000
  );

  it(
    '轮询 failed：抛出网关错误信息（业务失败不重试）',
    async () => {
      const captured: CapturedRequest[] = [];
      await expect(
        minimaxH3VideoAdapter.generateVideo(makeContext(captured, failedResponse), {
          model: 'minimax-h3',
          prompt: '一只猫',
          size: '720p@16:9',
          duration: 5,
        })
      ).rejects.toThrow('comfy execution error');
    },
    30_000
  );

  it('seconds 钳制：缺省 5，范围 1~10，params.seconds 字符串兜底', () => {
    expect(normalizeH3Seconds(undefined)).toBe('5');
    expect(normalizeH3Seconds(3)).toBe('3');
    expect(normalizeH3Seconds(99)).toBe('10');
    expect(normalizeH3Seconds(0)).toBe('5');
    expect(normalizeH3Seconds(-2)).toBe('1');
    expect(normalizeH3Seconds(undefined, '8')).toBe('8');
  });
});

describe('registry 全量注册下解析（事故回归守卫）', () => {
  it(
    '全量注册时 minimax-h3 仍路由到专属适配器，不被 gemini 兜底适配器截胡',
    () => {
      // 复刻 2026-11-04 线上事故：geminiVideoAdapter 的 matchPredicate 捕获所有
      // 非 kling/seedance/happyhorse 视频模型，minimax-h3 被截胡走
      // videoAPIService → 托管态无本地 apiKey → 「API Key 未配置」。
      // 修复 = gemini matchPredicate 排除 minimax + minimax.h3.task 专属 binding。
      clearModelAdapters();
      registerDefaultModelAdapters();
      const adapter = resolveAdapterForModel('minimax-h3', 'video');
      expect(adapter?.id).toBe('minimax-h3-video-adapter');
    },
  );

  it('minimax.h3.task binding 解析到专属适配器（binding 优先级高于 supportedModels）', () => {
    clearModelAdapters();
    registerDefaultModelAdapters();
    const binding = {
      bindingId: 'inferred-minimax-h3',
      modelId: 'minimax-h3',
      protocol: 'minimax.h3.task',
      requestSchema: 'minimax.h3.video.form',
      submitPath: '/v1/videos',
      priority: 615,
    } as unknown as ProviderModelBinding;
    const adapter = resolveAdapterForBinding(binding, 'video');
    expect(adapter?.id).toBe('minimax-h3-video-adapter');
  });
});

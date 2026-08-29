/**
 * REPRO 测试：生成图片未上传 huabu bucket（fallback-executor 两个完成分支缺归档）
 *
 * 线上现象：图片生成成功，但 Supabase huabu bucket 里没有任何生成的图片，
 * task_submissions.response_file_paths 也不更新。
 *
 * 根因：adapter 分支（executeImageViaAdapter，fallback-adapter-routes.ts）生成完成后
 * 会调用 archiveGeneratedMediaToSupabase 转存生成图片；但 fallback-executor 自身的
 * 两个完成分支把生成图片缓存到本地虚拟 URL（/__aitu_cache__/）后直接 completeTask，
 * 从不调用归档：
 *   1. 同步直接分支：/images/generations 直接调用（resolveAdapterForInvocation 无
 *      adapter 命中时），cacheRemoteUrls → completeTask，无归档；
 *   2. 异步分支：generateAsyncImageTask（openai.async.media 绑定），cacheRemoteUrl →
 *      completeTask，无归档。
 *
 * 修复后断言：两个分支生成成功后均调用
 * archiveGeneratedMediaToSupabase(taskId, cachedUrls)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImageGenerationParams } from './types';

const archiveGeneratedMediaToSupabase = vi.fn(async () => undefined);
const completeTask = vi.fn(async () => undefined);
const failTask = vi.fn(async () => undefined);
const updateStatus = vi.fn(async () => undefined);
const updateRemoteId = vi.fn(async () => undefined);
const startLLMApiLog = vi.fn(() => 'log-1');
const completeLLMApiLog = vi.fn();
const failLLMApiLog = vi.fn();
const classifyApiCredentialError = vi.fn(() => null);
const dispatchApiAuthError = vi.fn();
const providerSend = vi.fn();
const resolveInvocationPlanFromRoute = vi.fn();
const resolveAdapterForInvocation = vi.fn();
const resolveInvocationRoute = vi.fn(() => ({
  apiKey: 'test-key',
  baseUrl: 'https://upstream.example/v1',
  modelId: 'test-image-model',
  providerType: 'custom',
}));
const buildImageRequestBody = vi.fn(() => ({ prompt: 'a cat' }));
const parseImageResponse = vi.fn(() => ({
  url: 'https://upstream.example/direct-out.png',
  format: 'png',
}));
const ensureBase64ForAI = vi.fn(
  async (imageData: { value: string }) => imageData.value
);
const cacheRemoteUrl = vi.fn(
  async (_url: string, taskId: string) => `/__aitu_cache__/image/${taskId}.png`
);
const cacheRemoteUrls = vi.fn(async (urls: string[], taskId: string) =>
  urls.map((_url, index) => `/__aitu_cache__/image/${taskId}-${index}.png`)
);
const generateAsyncImage = vi.fn();

vi.mock('../task-supabase-archive/service', () => ({
  archiveGeneratedMediaToSupabase,
}));

vi.mock('./task-storage-writer', () => ({
  taskStorageWriter: { completeTask, failTask, updateStatus, updateRemoteId },
}));

vi.mock('./llm-api-logger', () => ({
  startLLMApiLog,
  completeLLMApiLog,
  failLLMApiLog,
  updateLLMApiLogMetadata: vi.fn(),
}));

vi.mock('../../utils/api-auth-error-event', () => ({
  classifyApiCredentialError,
  dispatchApiAuthError,
}));

vi.mock('../provider-routing', () => ({
  providerTransport: { send: providerSend },
  resolveInvocationPlanFromRoute,
}));

vi.mock('../model-adapters', () => ({
  resolveAdapterForInvocation,
  GPT_IMAGE_EDIT_REQUEST_SCHEMAS: ['openai.image.edit.form'],
}));

vi.mock('../../utils/settings-manager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInvocationRoute,
}));

vi.mock('./fallback-utils', () => ({
  buildImageRequestBody,
  parseImageResponse,
  pollVideoStatus: vi.fn(),
  generateAsyncImage,
  ensureBase64ForAI,
  cacheRemoteUrl,
  cacheRemoteUrls,
}));

vi.mock('../task-invocation-route', () => ({
  assertTaskInvocationRouteAvailable: vi.fn(),
  createTaskInvocationRouteSnapshot: vi.fn(() => null),
  resolveLegacyTaskInvocationRouteModel: vi.fn(() => null),
  shouldUseStrictTaskInvocationRoute: vi.fn(() => false),
}));

function makeParams(taskId: string): ImageGenerationParams {
  return {
    taskId,
    prompt: 'a cat',
    model: 'test-image-model',
    modelRef: null,
  } as unknown as ImageGenerationParams;
}

describe('REPRO: fallback-executor 生图完成点未把生成图片归档到 huabu bucket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认：无 async 绑定、无 adapter 命中 → 走同步直接分支
    resolveInvocationPlanFromRoute.mockReturnValue(undefined);
    resolveAdapterForInvocation.mockReturnValue(undefined);
    providerSend.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        created: 1,
        data: [{ url: 'https://upstream.example/direct-out.png' }],
      }),
    });
    generateAsyncImage.mockResolvedValue({
      url: 'https://upstream.example/async-out.png',
      format: 'png',
    });
  });

  it('同步直接分支（/images/generations）：生成成功 → 应调用 archiveGeneratedMediaToSupabase 转存生成图片', async () => {
    const { FallbackMediaExecutor } = await import('./fallback-executor');
    const executor = new FallbackMediaExecutor();

    await executor.generateImage(makeParams('task-direct-1'), {});

    // 生成本身成功（已缓存到本地虚拟 URL 并完成任务）
    expect(cacheRemoteUrls).toHaveBeenCalled();
    expect(completeTask).toHaveBeenCalled();
    // BUG：生成图片只落在本地缓存，没有任何上传归档 → bucket 永远没有生成图
    expect(archiveGeneratedMediaToSupabase).toHaveBeenCalledTimes(1);
    expect(archiveGeneratedMediaToSupabase).toHaveBeenCalledWith(
      'task-direct-1',
      expect.arrayContaining([
        expect.stringMatching(/^\/__aitu_cache__\/image\/task-direct-1/),
      ])
    );
  });

  it('异步分支（generateAsyncImageTask）：生成成功 → 应调用 archiveGeneratedMediaToSupabase 转存生成图片', async () => {
    resolveInvocationPlanFromRoute.mockImplementation(
      (taskType: string, model?: string | null) =>
        taskType === 'image' && model === 'test-image-model'
          ? {
              binding: { protocol: 'openai.async.media' },
              provider: { authType: 'bearer' },
            }
          : undefined
    );
    const { FallbackMediaExecutor } = await import('./fallback-executor');
    const executor = new FallbackMediaExecutor();

    await executor.generateImage(makeParams('task-async-1'), {});

    expect(generateAsyncImage).toHaveBeenCalled();
    expect(cacheRemoteUrl).toHaveBeenCalled();
    expect(completeTask).toHaveBeenCalled();
    // BUG：异步生图完成后同样没有归档上传
    expect(archiveGeneratedMediaToSupabase).toHaveBeenCalledTimes(1);
    expect(archiveGeneratedMediaToSupabase).toHaveBeenCalledWith(
      'task-async-1',
      ['/__aitu_cache__/image/task-async-1.png']
    );
  });
});
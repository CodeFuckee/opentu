/**
 * fallback-adapter-routes 复现/回归测试
 *
 * 复现线上 bug 的根因 2a：executeImageViaAdapter 调用 adapter.generateImage 时
 * 不携带 taskId → x-task-id 契约断裂 → providerTransport 响应归档钩子永不触发 →
 * upstream_response 恒为 NULL。
 *
 * 修复后断言：
 * - adapter 收到的 context.taskId === 任务 id
 * - 生图完成（本地缓存后）调用 archiveGeneratedMediaToSupabase(taskId, cachedUrls)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdapterContext, ImageModelAdapter } from '../model-adapters/types';

const getAdapterContextFromSettings = vi.fn();
const archiveGeneratedMediaToSupabase = vi.fn(async () => undefined);
const registerGeneratedMediaArchive = vi.fn();
const completeTask = vi.fn(async () => undefined);
const failTask = vi.fn(async () => undefined);
const startLLMApiLog = vi.fn(() => 'log-1');
const completeLLMApiLog = vi.fn();
const failLLMApiLog = vi.fn();
const classifyApiCredentialError = vi.fn(() => null);
const dispatchApiAuthError = vi.fn();
const getImageForAI = vi.fn();
const cacheRemoteUrls = vi.fn(async (urls: string[]) =>
  urls.map((u) => `/__aitu_cache__/image/${u.replace(/[^a-z0-9]/gi, '')}.png`)
);
const ensureBase64ForAI = vi.fn(async (imageData: { value: string }) => imageData.value);
const cacheRemoteUrl = vi.fn(async (url: string) => url);

vi.mock('../model-adapters', () => ({
  getAdapterContextFromSettings,
  GPT_IMAGE_EDIT_REQUEST_SCHEMAS: ['openai.image.edit.form'],
  isGPTImageEditRequestSchema: () => false,
}));

vi.mock('../task-supabase-archive/service', () => ({
  archiveGeneratedMediaToSupabase,
  registerGeneratedMediaArchive,
}));

vi.mock('./fallback-utils', () => ({
  ensureBase64ForAI,
  cacheRemoteUrl,
  cacheRemoteUrls,
}));

vi.mock('./task-storage-writer', () => ({
  taskStorageWriter: { completeTask, failTask },
}));

vi.mock('./llm-api-logger', () => ({
  startLLMApiLog,
  completeLLMApiLog,
  failLLMApiLog,
}));

vi.mock('../../utils/api-auth-error-event', () => ({
  classifyApiCredentialError,
  dispatchApiAuthError,
}));

vi.mock('../unified-cache-service', () => ({
  unifiedCacheService: { getImageForAI },
}));

describe('executeImageViaAdapter（taskId 透传 + 结果归档）', () => {
  let receivedContext: AdapterContext | undefined;
  const fakeAdapter: ImageModelAdapter = {
    id: 'fake-image-adapter',
    label: 'Fake',
    kind: 'image',
    matchRequestSchemas: ['fake.image.schema'],
    async generateImage(context, _request) {
      receivedContext = context;
      return { url: 'https://upstream.example/generated.png', format: 'png' };
    },
  };

  beforeEach(() => {
    receivedContext = undefined;
    getAdapterContextFromSettings.mockReset();
    getAdapterContextFromSettings.mockReturnValue({
      baseUrl: 'https://api.tu-zi.com/v1',
      operation: 'image',
      apiKey: 'k',
      authType: 'bearer',
    });
    archiveGeneratedMediaToSupabase.mockClear();
    registerGeneratedMediaArchive.mockClear();
    completeTask.mockClear();
    startLLMApiLog.mockClear();
  });

  it('REPRO→FIXED：adapter 收到的 context 携带 taskId（x-task-id 契约）', async () => {
    const { executeImageViaAdapter } = await import(
      './fallback-adapter-routes'
    );

    await executeImageViaAdapter(
      'task-id-123',
      fakeAdapter,
      {
        prompt: 'a cat',
        model: 'gpt-image-2',
        url: undefined,
      } as never,
      undefined,
      0
    );

    expect(receivedContext?.taskId).toBe('task-id-123');
  });

  it('FIXED：生图完成（本地缓存后）触发 archiveGeneratedMediaToSupabase', async () => {
    const { executeImageViaAdapter } = await import(
      './fallback-adapter-routes'
    );

    await executeImageViaAdapter(
      'task-id-456',
      fakeAdapter,
      {
        prompt: 'a cat',
        model: 'gpt-image-2',
      } as never,
      undefined,
      0
    );

    expect(registerGeneratedMediaArchive).toHaveBeenCalledTimes(1);
    const [taskId, urls] = registerGeneratedMediaArchive.mock.calls[0]!;
    expect(taskId).toBe('task-id-456');
    expect(Array.isArray(urls)).toBe(true);
    expect(urls[0]).toMatch(/^\/__aitu_cache__\/image\//);
    expect(completeTask).toHaveBeenCalledWith(
      'task-id-456',
      expect.objectContaining({ url: expect.stringContaining('/__aitu_cache__/') })
    );
  });
});
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskType } from '../../types/shared/core.types';
import { TaskExecutionPhase, TaskStatus } from '../../types/task.types';
import type { Task } from '../../types/shared/core.types';

const createTaskMock = vi.fn(async () => undefined);
const trackExternalTaskMock = vi.fn();
const syncTaskFromStorageMock = vi.fn();
const generateImageMock = vi.fn(async () => undefined);
const waitForTaskCompletionMock = vi.fn();
const waitForInitializationMock = vi.fn(async () => undefined);
const hasInvocationRouteCredentialsMock = vi.fn(() => true);
const getFallbackExecutorMock = vi.fn(() => ({
  generateImage: generateImageMock,
}));
const archiveTaskToSupabaseMock = vi.fn(async () => undefined);

vi.mock('../task-supabase-archive/service', () => ({
  archiveTaskToSupabase: archiveTaskToSupabaseMock,
}));

vi.mock('../media-executor/task-storage-writer', () => ({
  taskStorageWriter: {
    createTask: createTaskMock,
  },
}));

vi.mock('../media-executor', () => ({
  executorFactory: {
    getFallbackExecutor: getFallbackExecutorMock,
    getExecutor: vi.fn(),
  },
  waitForTaskCompletion: waitForTaskCompletionMock,
}));

vi.mock('../../utils/settings-manager', () => ({
  settingsManager: {
    waitForInitialization: waitForInitializationMock,
  },
  hasInvocationRouteCredentials: hasInvocationRouteCredentialsMock,
  // model-pricing-service 模块初始化会读取该配置（非数组时安全跳过），
  // 缺失此导出会导致该测试文件整体报错（基线既有失败）
  providerPricingCacheSettings: {
    get: () => undefined,
    set: () => undefined,
  },
}));

vi.mock('../task-queue-service', () => ({
  taskQueueService: {
    trackExternalTask: trackExternalTaskMock,
    syncTaskFromStorage: syncTaskFromStorageMock,
  },
}));

vi.mock('../../utils/task-utils', () => ({
  generateTaskId: () => 'task-image-1',
}));

vi.mock('../task-invocation-route', () => ({
  createTaskInvocationRouteSnapshot: () => undefined,
  assertTaskInvocationRouteAvailable: vi.fn(),
  resolveLegacyTaskInvocationRouteModel: vi.fn(() => null),
  shouldUseStrictTaskInvocationRoute: vi.fn(() => false),
}));

describe('image-generation-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    waitForTaskCompletionMock.mockResolvedValue({
      success: true,
      task: {
        id: 'task-image-1',
        type: TaskType.IMAGE,
        status: TaskStatus.COMPLETED,
        params: { prompt: 'Edit this' },
        createdAt: 1,
        updatedAt: 1,
        result: {
          url: 'https://example.com/out.png',
          format: 'png',
          size: 1,
        },
      } satisfies Task,
    });
  });

  it('persists the full image contract for edit-capable GPT requests', async () => {
    const { generateImage } = await import(
      '../media-generation/image-generation-service'
    );

    await generateImage('Edit this', {
      forceMainThread: true,
      model: 'gpt-image-2',
      size: '16x9',
      resolution: '2k',
      quality: 'high',
      generationMode: 'image_to_image',
      referenceImages: ['https://example.com/reference.png'],
      maskImage: 'https://example.com/mask.png',
      inputFidelity: 'high',
      background: 'transparent',
      outputFormat: 'png',
      outputCompression: 80,
      uploadedImages: [{ url: 'https://example.com/reference.png' }],
      count: 2,
    });

    expect(createTaskMock).toHaveBeenCalledWith(
      'task-image-1',
      'image',
      expect.objectContaining({
        prompt: 'Edit this',
        model: 'gpt-image-2',
        size: '16x9',
        resolution: '2k',
        quality: 'high',
        generationMode: 'image_to_image',
        referenceImages: ['https://example.com/reference.png'],
        maskImage: 'https://example.com/mask.png',
        inputFidelity: 'high',
        background: 'transparent',
        outputFormat: 'png',
        outputCompression: 80,
        uploadedImages: [{ url: 'https://example.com/reference.png' }],
        count: 2,
        params: {
          resolution: '2k',
          quality: 'high',
          n: 2,
        },
      }),
      // 第 4 参为 invocationRoute（此处 mock 返回 undefined）
      undefined
    );

    expect(trackExternalTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-image-1',
        type: TaskType.IMAGE,
        status: TaskStatus.PROCESSING,
        executionPhase: TaskExecutionPhase.SUBMITTING,
        params: expect.objectContaining({
          resolution: '2k',
          quality: 'high',
          generationMode: 'image_to_image',
          referenceImages: ['https://example.com/reference.png'],
          maskImage: 'https://example.com/mask.png',
          params: {
            resolution: '2k',
            quality: 'high',
            n: 2,
          },
        }),
      })
    );

    expect(generateImageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-image-1',
      }),
      expect.objectContaining({
        signal: undefined,
      })
    );
  });

  it('REPRO→FIXED：工作流/Agent 直接生成路径也应归档输入文件（archiveTaskToSupabase）', async () => {
    const { generateImage } = await import(
      '../media-generation/image-generation-service'
    );

    await generateImage('Edit this', {
      forceMainThread: true,
      model: 'gpt-image-2',
      referenceImages: ['https://example.com/reference.png'],
      uploadedImages: [{ url: 'https://example.com/reference.png' }],
      maskImage: 'https://example.com/mask.png',
    });

    // BUG：此路径此前从不调用归档 → 用户提交的参考图不入 huabu bucket、
    // task_submissions 无行（file_paths 恒为空）
    expect(archiveTaskToSupabaseMock).toHaveBeenCalledTimes(1);
    expect(archiveTaskToSupabaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-image-1',
        type: TaskType.IMAGE,
        params: expect.objectContaining({
          prompt: 'Edit this',
          referenceImages: ['https://example.com/reference.png'],
          uploadedImages: [{ url: 'https://example.com/reference.png' }],
          maskImage: 'https://example.com/mask.png',
        }),
      })
    );
  });
});

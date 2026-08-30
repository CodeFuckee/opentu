/**
 * task-supabase-archive URL 型媒体归档 REPRO 测试
 *
 * 复现：用户提交任务后 task_submissions.file_paths 为空列表，
 * 参考图与生成结果图都没有保存到 huabu bucket。
 *
 * 根因（归档函数只处理 dataURL 与可解析为 base64 的虚拟 URL，遗漏两类常见输入）：
 * 1. 输出侧：上游返回 OpenAI 格式 {data:[{url}]}（http URL）时，executor 的
 *    cacheRemoteUrl 对图片类型 http URL 原样返回不缓存（fallback-utils.ts:303），
 *    archiveGeneratedMediaToSupabase 收到 http URL 后调用 getImageForAI，
 *    真实实现对「未缓存的 http URL」返回 {type:'url'}（非 base64）→ 直接 skip →
 *    response_file_paths 恒为空，生成图不入桶。
 * 2. 输入侧：参考图在参数中是 http URL（如粘贴远程图、素材库远程引用）或
 *    虚拟 URL 但 getImageForAI 解析失败（缓存缺失降级返回 {type:'url'}）时，
 *    collectDataUrls / collectVirtualMediaUrls 路径均不会 fetch http URL 上传 →
 *    file_paths 恒为空，参考图不入桶。
 *
 * 本文件用「贴合真实语义」的 getImageForAI mock 复现上述两类断点：
 * - dataURL → {type:'base64', value: dataURL}
 * - 虚拟 URL（/asset-library/、/__aitu_cache__/）→ 缓存命中时 {type:'base64'}，
 *   缓存缺失时降级 {type:'url', value: 原URL}（与真实 unifiedCacheService 一致）
 * - http/https URL → {type:'url', value: 原URL}（未缓存，真实实现的常见分支）
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  archiveTaskToSupabase,
  archiveGeneratedMediaToSupabase,
} from './service';
import { configureTaskArchive } from './runtime';
import type { Task } from '../../types/task.types';
import { TaskStatus } from '../../types/task.types';

// 贴合真实 unifiedCacheService.getImageForAI 语义的 mock
const { getImageForAI, fetchSpy } = vi.hoisted(() => ({
  getImageForAI: vi.fn(),
  // 真实 fetch（用于归档函数直接 fetch http URL 取 blob）
  fetchSpy: vi.fn(),
}));
vi.mock('../unified-cache-service', () => ({
  unifiedCacheService: {
    getImageForAI,
  },
}));

const BASE64_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DATA_URL_PNG = `data:image/png;base64,${BASE64_PNG}`;
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0d, 0x0a, 0x1a, 0x0a,
]);

beforeEach(() => {
  getImageForAI.mockReset();
  fetchSpy.mockReset();
  // 真实语义：http URL 未缓存 → 返回 url 型（不转 base64）
  getImageForAI.mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.startsWith('data:')) {
      return { type: 'base64', value: url };
    }
    if (
      typeof url === 'string' &&
      (url.startsWith('/asset-library/') || url.startsWith('/__aitu_cache__/'))
    ) {
      // 默认缓存命中返回 base64；个别用例可在内部覆盖为降级
      return { type: 'base64', value: DATA_URL_PNG };
    }
    return { type: 'url', value: url };
  });
  // 真实 fetch：返回 PNG blob（供归档函数直接 fetch http/虚拟 URL 取 blob）
  fetchSpy.mockImplementation(async () => ({
    ok: true,
    blob: async () => new Blob([PNG_BYTES], { type: 'image/png' }),
  }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureTaskArchive(null);
});

interface MockUploadCall {
  path: string;
  blob: Blob;
  contentType?: string;
}

function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: 'task-url-repro',
    type: 'image' as Task['type'],
    status: TaskStatus.PROCESSING,
    params: { prompt: 'a cat' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  } as Task;
}

function makeMockClient() {
  const mock: {
    uploadCalls: MockUploadCall[];
    inserts: Array<{ row: Record<string, unknown>; opts: unknown }>;
    updates: Array<{ patch: Record<string, unknown>; taskId?: string }>;
  } = { uploadCalls: [], inserts: [], updates: [] };

  const client = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: {
              id: 'e9fd5a03-7c46-427f-a0bd-430995b4e713',
              email: 'chenkaidi@yjk.com',
            },
          },
        },
      }),
    },
    storage: {
      from: () => ({
        upload: async (path: string, blob: Blob, opts?: { contentType?: string }) => {
          mock.uploadCalls.push({ path, blob, contentType: opts?.contentType });
          return { error: null };
        },
      }),
    },
    from: (table: string) => {
      if (table === 'user_profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { oa_account: 'chenkaidi' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'task_submissions') {
        return {
          upsert: async (row: Record<string, unknown>, opts: unknown) => {
            mock.inserts.push({ row, opts });
            return { error: null };
          },
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              eq: (_f2: string, taskId: unknown) => {
                mock.updates.push({ patch, taskId: taskId as string });
                return Promise.resolve({ error: null });
              },
            }),
          }),
        };
      }
      return {};
    },
  };
  return { client, mock };
}

describe('REPRO: 输出侧 —— 生成结果为 http URL 应转存 huabu bucket', () => {
  it('archiveGeneratedMediaToSupabase 收到 http URL 应 fetch 取 blob 后上传 output 文件', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });
    // 模拟 executor 完成点：cacheRemoteUrl 对图片 http URL 原样返回
    const generatedHttpUrl = 'https://upstream.example/generated.png';

    await archiveGeneratedMediaToSupabase('task-img-1', [generatedHttpUrl]);

    // bug 现象：getImageForAI 对 http URL 返回 url 型 → 当前直接 skip，0 次上传
    // 期望：fetch http URL 取 blob 后上传，response_file_paths 非空
    expect(mock.uploadCalls).toHaveLength(1);
    expect(mock.uploadCalls[0]!.path).toMatch(
      /^chenkaidi\/\d{4}-\d{2}-\d{2}\/output-[0-9a-f]{64}\.png$/
    );
    expect(mock.updates).toHaveLength(1);
    expect(mock.updates[0]!.taskId).toBe('task-img-1');
    expect(mock.updates[0]!.patch.response_file_paths).toEqual([
      mock.uploadCalls[0]!.path,
    ]);
  });
});

describe('REPRO: 输入侧 —— 参考图为 http URL 应转存 huabu bucket', () => {
  it('archiveTaskToSupabase 参数中 http URL 参考图应 fetch 取 blob 后上传 input 文件', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });

    await archiveTaskToSupabase(
      makeTask({
        params: {
          prompt: '电商主图',
          uploadedImages: [
            { url: 'https://cdn.example.com/reference.png', name: 'ref.png' },
          ],
        },
      })
    );

    // bug 现象：collectDataUrls / collectVirtualMediaUrls 均不识别 http URL → 0 次上传，file_paths=[]
    // 期望：fetch http URL 取 blob 后上传，file_paths 非空
    expect(mock.uploadCalls).toHaveLength(1);
    expect(mock.uploadCalls[0]!.path).toMatch(
      /^chenkaidi\/\d{4}-\d{2}-\d{2}\/input-[0-9a-f]{64}\.png$/
    );
    expect(mock.inserts).toHaveLength(1);
    expect(mock.inserts[0]!.row.file_paths).toHaveLength(1);
  });
});

describe('REPRO: 输入侧 —— 虚拟 URL 解析降级（缓存缺失）应回退 fetch 原路径上传', () => {
  it('getImageForAI 对虚拟 URL 返回 url 型（缓存缺失降级）时不应静默跳过', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });
    // 覆盖默认：虚拟 URL 缓存缺失 → 降级返回 url 型（真实 unifiedCacheService 行为）
    const virtualUrl =
      '/asset-library/content-e2a01c075be85fba5376b6b84de7d393fc78ee25e0f6999a1b2c3d4e5f6.png';
    getImageForAI.mockResolvedValueOnce({ type: 'url', value: virtualUrl });

    await archiveTaskToSupabase(
      makeTask({
        params: {
          prompt: '电商主图',
          uploadedImages: [{ url: virtualUrl, name: 'ref.png' }],
        },
      })
    );

    // bug 现象：虚拟 URL 解析降级为 url 型 → 当前静默跳过，0 次上传，file_paths=[]
    // 期望：回退 fetch 虚拟 URL 取 blob 后上传（参考图不丢）
    expect(mock.uploadCalls).toHaveLength(1);
    expect(mock.inserts[0]!.row.file_paths).toHaveLength(1);
  });
});

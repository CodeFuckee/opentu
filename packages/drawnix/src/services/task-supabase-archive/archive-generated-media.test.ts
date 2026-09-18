/**
 * 生成结果媒体归档稳定性测试（重试加固 + result 回写）
 *
 * 覆盖：
 * - 上游 URL 下载抖动（先 5xx 后成功）→ 重试成功 → 上传 bucket，
 *   本地/服务端 result 回写：url 替换为内容寻址虚拟路径、source_url 保留原 URL、
 *   size 写真实字节数、archived 记录归档路径
 * - 上游持续失败（5xx × N）→ 重试耗尽 → 不上传、不回写
 * - 上游 200 + HTML 毒化响应 → 按失败重试 → 不入桶（防止毒化字节污染交付）
 * - b64 型结果 → size 真值回填 + response_file_paths 照常写入
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { archiveGeneratedMediaToSupabase } from './service';
import { configureTaskArchive } from './runtime';
import { sha256Hex } from './core';

const {
  getImageForAI,
  isCached,
  cacheMediaFromBlob,
  fetchSpy,
  updateTaskResult,
} = vi.hoisted(() => ({
  getImageForAI: vi.fn(),
  isCached: vi.fn(),
  cacheMediaFromBlob: vi.fn(),
  fetchSpy: vi.fn(),
  updateTaskResult: vi.fn(),
}));

vi.mock('../unified-cache-service', () => ({
  unifiedCacheService: {
    getImageForAI,
    isCached,
    cacheMediaFromBlob,
  },
}));

vi.mock('../media-executor/task-storage-writer', () => ({
  taskStorageWriter: { updateTaskResult },
}));

const BASE64_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DATA_URL_PNG = `data:image/png;base64,${BASE64_PNG}`;
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const HTML_BYTES = new TextEncoder().encode(
  '<html><body>502 Bad Gateway</body></html>'
);
const UPSTREAM_URL = 'https://upstream.example/generated.png';

beforeEach(() => {
  getImageForAI.mockReset();
  isCached.mockReset();
  cacheMediaFromBlob.mockReset();
  fetchSpy.mockReset();
  updateTaskResult.mockReset();

  // 默认：http URL 未缓存 → url 型（真实 unifiedCacheService 语义）
  getImageForAI.mockImplementation(async (url: string) => {
    if (url.startsWith('data:')) {
      return { type: 'base64', value: url };
    }
    return { type: 'url', value: url };
  });
  isCached.mockResolvedValue(false);
  cacheMediaFromBlob.mockResolvedValue(undefined);
  updateTaskResult.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetchSpy);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  configureTaskArchive(null);
});

function makeMockClient(existingResult: unknown = null) {
  const mock: {
    uploadCalls: Array<{ path: string; contentType?: string }>;
    updates: Array<{ patch: Record<string, unknown>; taskId?: string }>;
  } = { uploadCalls: [], updates: [] };

  const client = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: { id: 'e9fd5a03-7c46-427f-a0bd-430995b4e713', email: 'tester@yjk.com' },
          },
        },
      }),
    },
    storage: {
      from: () => ({
        upload: async (
          path: string,
          _blob: Blob,
          opts?: { contentType?: string }
        ) => {
          mock.uploadCalls.push({ path, contentType: opts?.contentType });
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
                data: { oa_account: 'tester' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'task_submissions') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: existingResult === null ? null : { result: existingResult },
                  error: null,
                }),
              }),
            }),
          }),
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

/** fetch 前几次返回 failure，之后返回 PNG blob */
function mockFetchFlakyThenOk(failures: number, failure: '5xx' | 'html' = '5xx') {
  let attempts = 0;
  fetchSpy.mockImplementation(async () => {
    attempts += 1;
    if (attempts <= failures) {
      if (failure === 'html') {
        return {
          ok: true,
          blob: async () => new Blob([HTML_BYTES], { type: 'text/html' }),
        };
      }
      return { ok: false, status: 503 };
    }
    return {
      ok: true,
      blob: async () => new Blob([PNG_BYTES], { type: 'image/png' }),
    };
  });
  return () => attempts;
}

describe('archiveGeneratedMediaToSupabase 重试加固与 result 回写', () => {
  it('上游 5xx 抖动后重试成功：上传 bucket 并回写本地/服务端 result（url 替换、source_url 保留、size 真值）', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });
    const getAttempts = mockFetchFlakyThenOk(2);

    const entriesPromise = archiveGeneratedMediaToSupabase('task-img-1', [
      UPSTREAM_URL,
    ]);
    await vi.runAllTimersAsync();
    const entries = await entriesPromise;

    const hash = await sha256Hex(PNG_BYTES);
    const stableUrl = `/__aitu_cache__/image/content-${hash}.png`;

    // 重试：2 次 503 + 1 次成功
    expect(getAttempts()).toBe(3);

    // 上传 bucket（与归档路径约定一致）
    expect(mock.uploadCalls).toHaveLength(1);
    expect(mock.uploadCalls[0]!.path).toMatch(
      /^tester\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{64}\.png$/
    );

    // 本地内容寻址缓存写入
    expect(cacheMediaFromBlob).toHaveBeenCalledTimes(1);
    expect(cacheMediaFromBlob.mock.calls[0]![0]).toBe(stableUrl);

    // 返回的 entries 描述替换映射
    expect(entries).toEqual([
      {
        sourceUrl: UPSTREAM_URL,
        stableUrl,
        storagePath: mock.uploadCalls[0]!.path,
        size: PNG_BYTES.length,
      },
    ]);

    // 服务端回写：response_file_paths + result 合并
    expect(mock.updates).toHaveLength(1);
    expect(mock.updates[0]!.taskId).toBe('task-img-1');
    const patch = mock.updates[0]!.patch;
    expect(patch.response_file_paths).toEqual([mock.uploadCalls[0]!.path]);
    const result = patch.result as Record<string, unknown>;
    expect(result.url).toBe(stableUrl);
    expect(result.source_url).toBe(UPSTREAM_URL);
    expect(result.size).toBe(PNG_BYTES.length);
    expect(result.archived).toMatchObject({
      via: 'generated-media-archive',
      paths: [mock.uploadCalls[0]!.path],
    });

    // 本地任务回填：updateTaskResult 收到合并函数，对旧 result 应用后得到稳定地址
    expect(updateTaskResult).toHaveBeenCalledTimes(1);
    const mergeFn = updateTaskResult.mock.calls[0]![1] as (
      prev: Record<string, unknown> | undefined
    ) => Record<string, unknown> | undefined | null;
    const merged = mergeFn({
      url: UPSTREAM_URL,
      urls: [UPSTREAM_URL],
      format: 'png',
      size: 0,
    });
    expect(merged).toMatchObject({
      url: stableUrl,
      source_url: UPSTREAM_URL,
      source_urls: [UPSTREAM_URL],
      urls: [stableUrl],
      size: PNG_BYTES.length,
    });
  });

  it('上游持续 5xx：重试耗尽后不上传、不回写（静默放弃，等待 reconcile 兜底）', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });
    fetchSpy.mockImplementation(async () => ({ ok: false, status: 503 }));

    const entriesPromise = archiveGeneratedMediaToSupabase('task-img-2', [
      UPSTREAM_URL,
    ]);
    await vi.runAllTimersAsync();
    const entries = await entriesPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(entries).toEqual([]);
    expect(mock.uploadCalls).toHaveLength(0);
    expect(mock.updates).toHaveLength(0);
    expect(updateTaskResult).not.toHaveBeenCalled();
  });

  it('上游 200 + HTML 毒化响应：按失败重试，不把错误页写入 bucket', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });
    const getAttempts = mockFetchFlakyThenOk(99, 'html');

    const entriesPromise = archiveGeneratedMediaToSupabase('task-img-3', [
      UPSTREAM_URL,
    ]);
    await vi.runAllTimersAsync();
    await entriesPromise;

    expect(getAttempts()).toBe(4);
    expect(mock.uploadCalls).toHaveLength(0);
    expect(mock.updates).toHaveLength(0);
  });

  it('b64 型结果：size 真值回填，response_file_paths 照常写入', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });
    const virtualUrl = '/__aitu_cache__/image/content-abc123.png';
    getImageForAI.mockResolvedValue({ type: 'base64', value: DATA_URL_PNG });

    const entriesPromise = archiveGeneratedMediaToSupabase('task-img-4', [
      virtualUrl,
    ]);
    await vi.runAllTimersAsync();
    const entries = await entriesPromise;

    const expectedBytes = Uint8Array.from(atob(BASE64_PNG), (c) =>
      c.charCodeAt(0)
    );

    expect(mock.uploadCalls).toHaveLength(1);
    expect(mock.updates).toHaveLength(1);
    const result = mock.updates[0]!.patch.result as Record<string, unknown>;
    expect(result.size).toBe(expectedBytes.length);
    expect(result.source_url).toBe(virtualUrl);
    expect(entries[0]!.size).toBe(expectedBytes.length);
  });
});

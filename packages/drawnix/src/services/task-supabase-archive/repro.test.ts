/**
 * task-supabase-archive REPRO 测试
 *
 * 复现线上 bug：生成成功但 huabu bucket 空（storage.objects = 0），
 * task_submissions 表有行但 file_paths=[], response_file_paths=[], upstream_response=NULL。
 *
 * 根因（两处）：
 * 1. 输入侧：用户提交的参考图在 params 中是 /asset-library/ 虚拟 URL（非 data URL），
 *    归档只收集 data: 前缀 → 不上传 → file_paths=[]。
 * 2. 输出侧：生成响应是 OpenAI 格式 {created, data:[{url}]}（无 base64、无 status 键），
 *    既非终态状态标记也没有 base64 → archiveUpstreamResponseToSupabase 直接跳过 →
 *    upstream_response 保持 NULL，生成图片永远不进 bucket。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  archiveTaskToSupabase,
  archiveUpstreamResponseToSupabase,
  archiveGeneratedMediaToSupabase,
} from './service';
import { configureTaskArchive } from './runtime';
import type { Task } from '../../types/task.types';
import { TaskStatus } from '../../types/task.types';
import { buildFileEntries } from './core';

// 虚拟 URL（素材库/缓存）解析：getImageForAI 返回 base64 dataURL
// （vi.hoisted 保证 mock 工厂在顶层变量初始化前可访问）
const { getImageForAI } = vi.hoisted(() => ({ getImageForAI: vi.fn() }));
vi.mock('../unified-cache-service', () => ({
  unifiedCacheService: {
    getImageForAI,
  },
}));

/** 线上真实结构：AI 图片弹窗上传参考图后存为素材库虚拟 URL */
const ASSET_LIBRARY_URL =
  '/asset-library/content-e2a01c075be85fba5376b6b84de7d393fc78ee25e0f6999a1b2c3d4e5f6.png';
const BASE64_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DATA_URL_PNG = `data:image/png;base64,${BASE64_PNG}`;

beforeEach(() => {
  getImageForAI.mockReset();
  // 素材库/缓存虚拟 URL → base64 dataURL（与真实 unifiedCacheService 行为一致）
  getImageForAI.mockImplementation(async (url: string) =>
    url.startsWith('/asset-library/') || url.startsWith('/__aitu_cache__/')
      ? { type: 'base64', value: DATA_URL_PNG }
      : { type: 'url', value: url }
  );
});

interface MockUploadCall {
  path: string;
  blob: Blob;
  contentType?: string;
}

function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: 'task-repro',
    type: 'image' as Task['type'],
    status: TaskStatus.PROCESSING,
    params: {
      prompt: 'a cat',
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  } as Task;
}

function makeMockClient(
  overrides: Partial<{
    username?: string;
    email?: string;
    hasSession?: boolean;
  }> = {}
) {
  const mock: {
    uploadCalls: MockUploadCall[];
    inserts: Array<{ row: Record<string, unknown>; opts: unknown }>;
    updates: Array<{ patch: Record<string, unknown>; taskId?: string }>;
  } = {
    uploadCalls: [],
    inserts: [],
    updates: [],
  };
  const {
    username = 'chenkaidi',
    email = 'chenkaidi@yjk.com',
    hasSession = true,
  } = overrides;

  const client = {
    auth: {
      getSession: async () =>
        hasSession
          ? {
              data: {
                session: {
                  user: { id: 'e9fd5a03-7c46-427f-a0bd-430995b4e713', email },
                },
              },
            }
          : { data: { session: null } },
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
              maybeSingle: async () =>
                username !== undefined
                  ? { data: { oa_account: username }, error: null }
                  : { data: null, error: null },
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
            eq: (_field: string, _value: unknown) => ({
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

afterEach(() => {
  configureTaskArchive(null);
});

describe('REPRO: 输入侧 —— 素材库虚拟 URL 参考图应上传 huabu bucket', () => {
  it('用户上传的图片（/asset-library/ 虚拟 URL）应解析并上传 input 文件', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });

    await archiveTaskToSupabase(
      makeTask({
        params: {
          prompt: '电商主图',
          model: 'gpt-image-2',
          uploadedImages: [{ url: ASSET_LIBRARY_URL, name: 'ref.png' }],
        },
      })
    );

    // bug 现象：当前 0 次上传，file_paths 为空 —— 期望 1 次上传
    expect(mock.uploadCalls).toHaveLength(1);
    expect(mock.uploadCalls[0]!.path).toMatch(
      /^chenkaidi\/\d{4}-\d{2}-\d{2}\/input-[0-9a-f]{64}\.png$/
    );
    expect(mock.inserts).toHaveLength(1);
    const { row } = mock.inserts[0]!;
    expect(row.file_paths).toHaveLength(1);
    // 参数中以 bucket 存储路径替换虚拟 URL
    expect((row.params as any).uploadedImages[0].url).toMatch(
      /^chenkaidi\/\d{4}-\d{2}-\d{2}\/input-/
    );
  });
});

describe('REPRO: 输出侧 —— OpenAI 格式 URL 图片响应应归档', () => {
  it('同步生图返回 {created, data:[{url}]}（无 base64、无 status）也不应跳过', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });

    await archiveUpstreamResponseToSupabase('task-img-1', {
      created: 1,
      data: [{ url: 'https://upstream.example/generated.png' }],
    });

    // bug 现象：当前既不上传也不写库（upstream_response 保持 NULL）—— 期望至少写库
    expect(mock.uploadCalls.length + mock.updates.length).toBeGreaterThan(0);
    expect(mock.updates).toHaveLength(1);
    const { patch, taskId } = mock.updates[0]!;
    expect(taskId).toBe('task-img-1');
    expect((patch.upstream_response as any).data[0].url).toBe(
      'https://upstream.example/generated.png'
    );
  });
});

describe('REPRO: 输出侧 —— 生成结果媒体转存 huabu bucket', () => {
  it('executor 完成点传入本地缓存 URL → 上传 output 文件并写 response_file_paths', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });

    await archiveGeneratedMediaToSupabase('task-result-1', [
      '/__aitu_cache__/image/content-b409e7f531f6afd35856680f2924806095feb4796748b952054fafaef2f11117.png',
    ]);

    expect(mock.uploadCalls).toHaveLength(1);
    expect(mock.uploadCalls[0]!.path).toMatch(
      /^chenkaidi\/\d{4}-\d{2}-\d{2}\/output-[0-9a-f]{64}\.png$/
    );
    expect(mock.updates).toHaveLength(1);
    const { patch, taskId } = mock.updates[0]!;
    expect(taskId).toBe('task-result-1');
    expect(patch.response_file_paths).toEqual([mock.uploadCalls[0]!.path]);
  });

  it('未注册配置 / 空 URL 列表时静默跳过', async () => {
    const { mock } = makeMockClient();
    await archiveGeneratedMediaToSupabase('task-1', []);
    expect(mock.uploadCalls).toHaveLength(0);
  });
});

describe('回归：data URL 参考图仍按原逻辑归档', () => {
  it('buildFileEntries 对 data URL 生成 input 存储路径', async () => {
    const { entries } = await buildFileEntries(
      { uploadedImages: [{ url: DATA_URL_PNG }] },
      'chenkaidi',
      '2026-08-30'
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.storagePath).toMatch(
      /^chenkaidi\/2026-08-30\/input-[0-9a-f]{64}\.png$/
    );
  });

  it('纯 data URL 参数经 archiveTaskToSupabase 正常上传并替换', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });
    await archiveTaskToSupabase(
      makeTask({
        params: {
          prompt: 'a cat',
          uploadedImages: [{ url: DATA_URL_PNG, name: 'cat.png' }],
        },
      })
    );
    expect(mock.uploadCalls).toHaveLength(1);
    expect((mock.inserts[0]!.row as any).file_paths).toHaveLength(1);
  });
});
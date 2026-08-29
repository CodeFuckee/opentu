/**
 * task-supabase-archive service 单测
 *
 * 用注入的假 SupabaseClient 验证归档与终态回写流程：
 * - 未注册配置 → 静默跳过
 * - 无会话 → 静默跳过
 * - 用户名解析：oa_account 优先，邮箱前缀回退
 * - 上传成功 → storage.upload 参数正确、insert 参数被替换、file_paths 记录
 * - 上传失败 → 静默、该 param 保留 dataURL、仍插入
 * - 终态回写：completed 带 result / failed 带 error / cancelled
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  archiveTaskToSupabase,
  updateTaskSubmissionOnTerminal,
  archiveUpstreamResponseToSupabase,
  archiveUpstreamResponseFromFetch,
} from './service';
import { configureTaskArchive } from './runtime';
import type { Task } from '../../types/task.types';
import { TaskStatus } from '../../types/task.types';

const BASE64_OF_ABC = 'YWJj';
const DATA_URL_PNG = `data:image/png;base64,${BASE64_OF_ABC}`;

interface MockUploadCall {
  path: string;
  blob: Blob;
  contentType?: string;
}

function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    type: 'image' as Task['type'],
    status: TaskStatus.PROCESSING,
    params: {
      prompt: 'a cat',
      uploadedImages: [{ url: DATA_URL_PNG, name: 'cat.png' }],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  } as Task;
}

interface MockClient {
  uploadCalls: MockUploadCall[];
  inserts: Array<{ row: Record<string, unknown>; opts: unknown }>;
  updates: Array<{ patch: Record<string, unknown>; taskId?: string }>;
  failUpload: boolean;
  username: string | undefined;
  email: string | undefined;
  hasSession: boolean;
}

function makeMockClient(overrides: Partial<MockClient> = {}): {
  client: unknown;
  mock: MockClient;
} {
  const mock: MockClient = {
    uploadCalls: [],
    inserts: [],
    updates: [],
    failUpload: false,
    username: 'zhangsan',
    email: 'zhangsan@yjk.com',
    hasSession: true,
    ...overrides,
  };

  const client = {
    auth: {
      getSession: async () =>
        mock.hasSession
          ? {
              data: {
                session: {
                  user: { id: 'u-1', email: mock.email },
                },
              },
            }
          : { data: { session: null } },
    },
    storage: {
      from: () => ({
        upload: async (path: string, blob: Blob, opts?: { contentType?: string }) => {
          mock.uploadCalls.push({ path, blob, contentType: opts?.contentType });
          if (mock.failUpload) {
            return { error: new Error('upload failed') };
          }
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
                mock.username !== undefined
                  ? { data: { oa_account: mock.username }, error: null }
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

describe('archiveTaskToSupabase', () => {
  it('未注册配置时静默跳过', async () => {
    const task = makeTask();
    await expect(archiveTaskToSupabase(task)).resolves.toBeUndefined();
  });

  it('无会话时静默跳过（不 upload 不 insert）', async () => {
    const { client, mock } = makeMockClient({ hasSession: false });
    configureTaskArchive({ client: client as never });
    await archiveTaskToSupabase(makeTask());
    expect(mock.uploadCalls).toHaveLength(0);
    expect(mock.inserts).toHaveLength(0);
  });

  it('oa_account 为空时回退邮箱前缀继续归档', async () => {
    const { client, mock } = makeMockClient({
      username: undefined,
      email: 'zhangsan@yjk.com',
    });
    configureTaskArchive({ client: client as never });
    await archiveTaskToSupabase(makeTask());
    expect(mock.uploadCalls).toHaveLength(1);
    expect(mock.uploadCalls[0]!.path).toMatch(/^zhangsan\//);
    expect(mock.inserts).toHaveLength(1);
  });

  it('oa_account 与邮箱都为空时静默跳过', async () => {
    const { client, mock } = makeMockClient({
      username: undefined,
      email: undefined,
    });
    configureTaskArchive({ client: client as never });
    await archiveTaskToSupabase(makeTask());
    expect(mock.uploadCalls).toHaveLength(0);
    expect(mock.inserts).toHaveLength(0);
  });

  it('上传成功后 insert 参数被替换为路径、记录 file_paths', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });
    await archiveTaskToSupabase(makeTask());

    expect(mock.uploadCalls).toHaveLength(1);
    const upload = mock.uploadCalls[0]!;
    expect(upload.path).toMatch(/^zhangsan\/\d{4}-\d{2}-\d{2}\/input-[0-9a-f]{64}\.png$/);
    expect(upload.contentType).toBe('image/png');

    expect(mock.inserts).toHaveLength(1);
    const { row, opts } = mock.inserts[0]!;
    expect(row.task_id).toBe('task-1');
    expect(row.type).toBe('image');
    expect(row.status).toBe('submitted');
    expect((row.params as any).uploadedImages[0].url).not.toBe(DATA_URL_PNG);
    expect((row.params as any).prompt).toBe('a cat');
    expect(row.file_paths).toEqual([upload.path]);
    expect(opts).toEqual({ onConflict: 'user_id,task_id' });
  });

  it('上传失败时静默、参数保留 dataURL、仍插入（file_paths 为空）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { client, mock } = makeMockClient({ failUpload: true });
      configureTaskArchive({ client: client as never });
      await archiveTaskToSupabase(makeTask());

      expect(mock.uploadCalls).toHaveLength(1);
      expect(mock.inserts).toHaveLength(1);
      const { row } = mock.inserts[0]!;
      expect((row.params as any).uploadedImages[0].url).toBe(DATA_URL_PNG);
      expect(row.file_paths).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('无文件参数时上传为空、仍插入', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never });
    await archiveTaskToSupabase(
      makeTask({ params: { prompt: 'hello', model: 'flux' } })
    );
    expect(mock.uploadCalls).toHaveLength(0);
    expect(mock.inserts).toHaveLength(1);
  });
});

describe('updateTaskSubmissionOnTerminal', () => {
  it('未注册配置时静默跳过', async () => {
    await expect(
      updateTaskSubmissionOnTerminal(makeTask({ status: TaskStatus.COMPLETED }))
    ).resolves.toBeUndefined();
  });

  it('completed 回写 status + result', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never });
    const task = makeTask({
      status: TaskStatus.COMPLETED,
      result: { url: 'https://x/1.png', format: 'png', size: 10 },
    });
    await updateTaskSubmissionOnTerminal(task);

    expect(mock.updates).toHaveLength(1);
    const { patch, taskId } = mock.updates[0]!;
    expect(taskId).toBe('task-1');
    expect(patch.status).toBe('completed');
    expect((patch.result as any).url).toBe('https://x/1.png');
    expect(patch.completed_at).toBeDefined();
  });

  it('failed 回写 status + error', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never });
    await updateTaskSubmissionOnTerminal(
      makeTask({ status: TaskStatus.FAILED, error: { code: 'X', message: 'boom' } })
    );
    expect(mock.updates[0]!.patch.status).toBe('failed');
    expect((mock.updates[0]!.patch.error as any).code).toBe('X');
  });

  it('cancelled 回写 status', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never });
    await updateTaskSubmissionOnTerminal(
      makeTask({ status: TaskStatus.CANCELLED })
    );
    expect(mock.updates[0]!.patch.status).toBe('cancelled');
  });

  it('无会话时静默跳过', async () => {
    const { client, mock } = makeMockClient({ hasSession: false });
    configureTaskArchive({ client: client as never });
    await updateTaskSubmissionOnTerminal(
      makeTask({ status: TaskStatus.COMPLETED })
    );
    expect(mock.updates).toHaveLength(0);
  });
});

describe('archiveUpstreamResponseToSupabase（响应归档，方案 B）', () => {
  it('未注册配置 / 无 taskId 时静默跳过', async () => {
    await expect(
      archiveUpstreamResponseToSupabase('', { data: [{ b64_json: 'YWJj' }] })
    ).resolves.toBeUndefined();
  });

  it('中间态轮询响应不归档（无 base64、非终态）', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never });
    await archiveUpstreamResponseToSupabase('task-1', {
      status: 'processing',
      progress: 40,
    });
    expect(mock.uploadCalls).toHaveLength(0);
    expect(mock.inserts).toHaveLength(0);
  });

  it('同步生图成功（含 b64_json）→ 上传 output 文件 + 更新 upstream_response', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never, bucketName: 'huabu' });
    await archiveUpstreamResponseToSupabase('task-img-1', {
      created: 1,
      data: [{ b64_json: BASE64_OF_ABC, revised_prompt: 'x' }],
    });

    expect(mock.uploadCalls).toHaveLength(1);
    const upload = mock.uploadCalls[0]!;
    expect(upload.path).toMatch(
      /^zhangsan\/\d{4}-\d{2}-\d{2}\/output-[0-9a-f]{64}\.png$/
    );
    expect(upload.contentType).toBe('image/png');

    // 响应归档仅更新已有行（update），不做 INSERT（避免缺 type 的 23502）
    expect(mock.inserts).toHaveLength(0);
    expect(mock.updates).toHaveLength(1);
    const { patch, taskId } = mock.updates[0]!;
    expect(taskId).toBe('task-img-1');
    expect((patch.upstream_response as any).data[0].b64_json).toBe(upload.path);
    expect(patch.response_file_paths).toEqual([upload.path]);
  });

  it('终态响应（无 base64）也归档 upstream_response', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never });
    await archiveUpstreamResponseToSupabase('task-poll-1', {
      id: 'v-1',
      status: 'completed',
      url: 'https://x/out.png',
    });
    expect(mock.uploadCalls).toHaveLength(0);
    expect(mock.updates).toHaveLength(1);
    const { patch } = mock.updates[0]!;
    expect((patch.upstream_response as any).status).toBe('completed');
    expect(patch.response_file_paths).toEqual([]);
  });

  it('上传失败时静默、base64 保留原值入库', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { client, mock } = makeMockClient({ failUpload: true });
      configureTaskArchive({ client: client as never });
      await archiveUpstreamResponseToSupabase('task-fail-1', {
        data: [{ b64_json: BASE64_OF_ABC }],
      });
      expect(mock.uploadCalls).toHaveLength(1);
      expect(mock.updates).toHaveLength(1);
      const { patch } = mock.updates[0]!;
      expect((patch.upstream_response as any).data[0].b64_json).toBe(
        BASE64_OF_ABC
      );
      expect(patch.response_file_paths).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('无会话时静默跳过', async () => {
    const { client, mock } = makeMockClient({ hasSession: false });
    configureTaskArchive({ client: client as never });
    await archiveUpstreamResponseToSupabase('task-1', {
      data: [{ b64_json: 'YWJj' }],
    });
    expect(mock.uploadCalls).toHaveLength(0);
    expect(mock.inserts).toHaveLength(0);
  });
});

describe('archiveUpstreamResponseFromFetch（providerTransport 挂点）', () => {
  it('无 taskId / 非 JSON 响应静默跳过且不影响原响应', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never });

    const response = new Response('not-json', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
    await archiveUpstreamResponseFromFetch(undefined, response);
    expect(mock.inserts).toHaveLength(0);
  });

  it('clone 读取响应 body 归档，原响应仍可被消费', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never });

    const response = new Response(
      JSON.stringify({ data: [{ b64_json: 'YWJj' }] }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
    await archiveUpstreamResponseFromFetch('task-fetch-1', response);

    expect(mock.uploadCalls).toHaveLength(1);
    expect(mock.updates).toHaveLength(1);
    const body = await response.json();
    expect((body as any).data[0].b64_json).toBe('YWJj');
  });

  it('≥400 失败响应强制归档错误 JSON', async () => {
    const { client, mock } = makeMockClient();
    configureTaskArchive({ client: client as never });

    const response = new Response(
      JSON.stringify({ error: { message: '预扣费额度失败' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
    await archiveUpstreamResponseFromFetch('task-err-1', response);
    expect(mock.updates).toHaveLength(1);
    const { patch } = mock.updates[0]!;
    expect(
      (patch.upstream_response as any).error.message
    ).toMatch(/预扣费额度失败/);
  });
});

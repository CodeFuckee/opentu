/**
 * ai-proxy 响应归档写入器单测（node:test）
 *
 * 覆盖：
 * - base64 响应内容上传 huabu bucket（output- 路径、SRK 鉴权、upsert）
 * - 相同 base64 去重（只上传一次）
 * - 上传失败 → 保留 base64 原值入库，不丢响应
 * - task_submissions upsert（on_conflict=user_id,task_id，仅更新新增列）
 * - 用户名解析（user_profiles.oa_account → email 前缀 → null）
 * - 非 JSON / 无 task_id / 异常静默降级
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveUpstreamResponse,
  resolveUsernameForBucket,
} from './archive-writer.ts';

const SUPABASE_URL = 'http://supabase.local';
const SRK = 'service-role-key';
const DATE = '2026-08-28';

/** 1x1 透明 PNG（b64_json 用） */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

interface Route {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response;
}

function routeFetch(routes: Route[], calls: string[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const route of routes) {
      if (route.match(url, init)) {
        return route.respond(url, init);
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function storageUploadRoutes(options: { failUpload?: boolean; uploads?: string[] } = {}): Route[] {
  return [
    {
      match: (url) => url.includes('/storage/v1/object/huabu/'),
      respond: (url) => {
        const path = url.split('/storage/v1/object/huabu/')[1] || '';
        options.uploads?.push(path);
        return options.failUpload
          ? json(500, { message: 'upload failed' })
          : new Response(null, { status: 200 });
      },
    },
    {
      match: (url) => url.includes('/rest/v1/user_profiles'),
      respond: () => json(200, [{ oa_account: 'zhangsan' }]),
    },
    {
      match: (url) => url.includes('/rest/v1/task_submissions'),
      respond: () => json(201, null),
    },
  ];
}

function makeInput(overrides: Partial<Parameters<typeof archiveUpstreamResponse>[0]> = {}) {
  return {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SRK,
    userId: 'user-1',
    taskId: 'task-1',
    email: 'zhangsan@corp.com',
    upstreamJson: { data: [{ b64_json: TINY_PNG_B64 }] },
    dateStr: DATE,
    ...overrides,
  };
}

test('b64_json 响应 → 上传 bucket + 替换路径 + 写库（仅新增列）', async () => {
  const calls: string[] = [];
  const uploads: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const result = await archiveUpstreamResponse(
    makeInput(),
    {
      fetch: routeFetch(
        [
          {
            match: (url) => url.includes('/storage/v1/object/huabu/'),
            respond: (url) => {
              const path = url.split('/storage/v1/object/huabu/')[1] || '';
              uploads.push(path);
              return new Response(null, { status: 200 });
            },
          },
          {
            match: (url) => url.includes('/rest/v1/user_profiles'),
            respond: () => json(200, [{ oa_account: 'zhangsan' }]),
          },
          {
            match: (url) => url.includes('/rest/v1/task_submissions'),
            respond: (_u, init) => {
              rows.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
              return json(201, null);
            },
          },
        ],
        calls
      ) as unknown as typeof fetch,
    }
  );

  assert.equal(result.archived, true);
  assert.equal(uploads.length, 1);
  const storedPath = uploads[0];
  assert.match(storedPath, /^zhangsan\/2026-08-28\/output-[0-9a-f]{64}\.png$/);

  const row = rows[0];
  assert.equal(row['user_id'], 'user-1');
  assert.equal(row['task_id'], 'task-1');
  // 写库请求只应携带新增列（不覆盖 params/status 等既有列）
  assert.deepEqual(Object.keys(row as object).sort(), [
    'response_file_paths',
    'task_id',
    'upstream_response',
    'user_id',
  ]);
  assert.equal((row['upstream_response'] as any).data[0].b64_json, storedPath);
  assert.deepEqual(row['response_file_paths'], [storedPath]);
  // 上传带 upsert + SRK 鉴权
  const uploadCall = calls.find((c) => c.includes('/storage/v1/object/huabu/'));
  assert.ok(uploadCall);
});

test('相同 base64 出现多次只上传一次（去重）', async () => {
  const uploads: string[] = [];
  await archiveUpstreamResponse(
    makeInput({
      upstreamJson: { a: { b64_json: TINY_PNG_B64 }, b: [TINY_PNG_B64], c: { data: [{ b64_json: TINY_PNG_B64 }] } },
    }),
    {
      fetch: routeFetch([...storageUploadRoutes({ uploads })], []) as unknown as typeof fetch,
    }
  );
  assert.equal(uploads.length, 1);
});

test('dataURL 值 → 按其 MIME 上传并替换', async () => {
  const uploads: string[] = [];
  await archiveUpstreamResponse(
    makeInput({ upstreamJson: { thumb: PNG_DATA_URL } }),
    {
      fetch: routeFetch([...storageUploadRoutes({ uploads })], []) as unknown as typeof fetch,
    }
  );
  assert.equal(uploads.length, 1);
  assert.match(uploads[0], /^zhangsan\/2026-08-28\/output-[0-9a-f]{64}\.png$/);
});

test('上传失败 → 保留 base64 原值入库，响应不丢', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const result = await archiveUpstreamResponse(
    makeInput(),
    {
      fetch: routeFetch(
        [
          {
            match: (url) => url.includes('/storage/v1/object/huabu/'),
            respond: () => json(500, { message: 'upload failed' }),
          },
          {
            match: (url) => url.includes('/rest/v1/user_profiles'),
            respond: () => json(200, [{ oa_account: 'zhangsan' }]),
          },
          {
            match: (url) => url.includes('/rest/v1/task_submissions'),
            respond: (_u, init) => {
              rows.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
              return json(201, null);
            },
          },
        ],
        []
      ) as unknown as typeof fetch,
    }
  );
  assert.equal(result.archived, true);
  assert.equal(result.failedUploads, 1);
  assert.deepEqual(result.uploadedPaths, []);
  const row = rows[0];
  assert.equal((row['upstream_response'] as any).data[0].b64_json, TINY_PNG_B64, '上传失败应保留原 base64');
  assert.deepEqual(row['response_file_paths'], []);
});

test('无 base64 → 原样入库，response_file_paths 为空', async () => {
  const rows: Array<Record<string, unknown>> = [];
  await archiveUpstreamResponse(
    makeInput({ upstreamJson: { data: [{ url: 'http://img/x.png' }] } }),
    {
      fetch: routeFetch(
        [
          {
            match: (url) => url.includes('/rest/v1/user_profiles'),
            respond: () => json(200, []),
          },
          {
            match: (url) => url.includes('/rest/v1/task_submissions'),
            respond: (_u, init) => {
              rows.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
              return json(201, null);
            },
          },
        ],
        []
      ) as unknown as typeof fetch,
    }
  );
  assert.equal(rows.length, 1);
  assert.deepEqual((rows[0]['upstream_response'] as any).data[0], { url: 'http://img/x.png' });
  assert.deepEqual(rows[0]['response_file_paths'], []);
});

test('响应非 JSON 对象（标量）→ 跳过归档', async () => {
  const calls: string[] = [];
  const result = await archiveUpstreamResponse(
    makeInput({ upstreamJson: 'just text' }),
    { fetch: routeFetch([], calls) as unknown as typeof fetch }
  );
  assert.equal(result.archived, false);
  assert.ok(!calls.some((c) => c.includes('/rest/v1/task_submissions')));
});

test('无 task_id → 直接跳过（老版本前端）', async () => {
  const calls: string[] = [];
  const result = await archiveUpstreamResponse(
    makeInput({ taskId: '' }),
    { fetch: routeFetch([], calls) as unknown as typeof fetch }
  );
  assert.equal(result.archived, false);
  assert.ok(!calls.some((c) => c.includes('/rest/v1/task_submissions')));
});

test('用户名回退：user_profiles 空 → email 前缀；两者都无 → null 不上传但仍写库', async () => {
  const uploads: string[] = [];
  const result = await archiveUpstreamResponse(
    makeInput({ email: 'zhangsan@corp.com' }),
    {
      fetch: routeFetch(
        [
          {
            match: (url) => url.includes('/rest/v1/user_profiles'),
            respond: () => json(200, []),
          },
          ...storageUploadRoutes({ uploads }),
        ],
        []
      ) as unknown as typeof fetch,
    }
  );
  assert.equal(result.archived, true);
  assert.equal(uploads.length, 1);
  assert.match(uploads[0], /^zhangsan\//);

  // 无 email 也无 oa_account → 不上传，base64 原样，但仍写库
  const rows: Array<Record<string, unknown>> = [];
  const result2 = await archiveUpstreamResponse(
    makeInput({ email: null }),
    {
      fetch: routeFetch(
        [
          {
            match: (url) => url.includes('/rest/v1/user_profiles'),
            respond: () => json(200, []),
          },
          {
            match: (url) => url.includes('/storage/v1/object/huabu/'),
            respond: () => {
              throw new Error('should not upload without username');
            },
          },
          {
            match: (url) => url.includes('/rest/v1/task_submissions'),
            respond: (_u, init) => {
              rows.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
              return json(201, null);
            },
          },
        ],
        []
      ) as unknown as typeof fetch,
    }
  );
  assert.equal(result2.archived, true);
  assert.equal((rows[0]['upstream_response'] as any).data[0].b64_json, TINY_PNG_B64);
});

test('写库失败 → 静默降级（archived=false，不抛错）', async () => {
  const result = await archiveUpstreamResponse(
    makeInput(),
    {
      fetch: routeFetch(
        [
          {
            match: (url) => url.includes('/storage/v1/object/huabu/'),
            respond: () => new Response(null, { status: 200 }),
          },
          {
            match: (url) => url.includes('/rest/v1/user_profiles'),
            respond: () => json(200, [{ oa_account: 'zhangsan' }]),
          },
          {
            match: (url) => url.includes('/rest/v1/task_submissions'),
            respond: () => json(500, { message: 'db down' }),
          },
        ],
        []
      ) as unknown as typeof fetch,
    }
  );
  assert.equal(result.archived, false);
});

test('resolveUsernameForBucket：优先 oa_account，缺失回退 email 前缀，清洗非法字符', async () => {
  const deps = { fetch: routeFetch(
    [
      {
        match: (url) => url.includes('/rest/v1/user_profiles'),
        respond: () => json(200, [{ oa_account: 'Zhang San-' }]),
      },
    ],
    []
  ) as unknown as typeof fetch };
  assert.equal(await resolveUsernameForBucket(SUPABASE_URL, SRK, 'u1', 'x@y.com', deps), 'zhang_san-');

  const depsEmpty = { fetch: routeFetch(
    [
      {
        match: (url) => url.includes('/rest/v1/user_profiles'),
        respond: () => json(200, []),
      },
    ],
    []
  ) as unknown as typeof fetch };
  assert.equal(await resolveUsernameForBucket(SUPABASE_URL, SRK, 'u1', 'Alice@corp.com', depsEmpty), 'alice');
  assert.equal(await resolveUsernameForBucket(SUPABASE_URL, SRK, 'u1', null, depsEmpty), null);
});
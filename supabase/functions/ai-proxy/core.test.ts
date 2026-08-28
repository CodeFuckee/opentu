/**
 * ai-proxy Edge Function 单测（node:test）
 *
 * 覆盖：
 * - 未带/无效 JWT → 401，不调用上游
 * - 额度扣减被拒 → 403 quota_exceeded，不调用上游
 * - 同步生图成功 → 扣减 + 上游收到注入的 apikey
 * - 同步生图上游失败 → 自动退回
 * - 异步提交成功 → 记账；轮询终态失败 → 一次性退回
 * - 视频模型提交（模型名不含 image）→ 不计费直通
 * - quota 端点返回剩余额度
 * - 非 JSON 响应原样透传
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleAiProxyRequest,
  classifyBilling,
  extractBearerToken,
  isPollingPath,
  detectTerminalFailure,
} from './core.ts';

const SUPABASE_URL = 'http://supabase.local';
const SRK = 'service-role-key';
const NEWAPI_URL = 'http://newapi.local:3000';
const NEWAPI_KEY = 'sk-global-newapi-key';

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

const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  status === 204 || status === 304
    ? new Response(null, {
        status,
        headers: headers ? { ...headers } : undefined,
      })
    : new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      });

const baseRoutes = (): Route[] => [
  {
    match: (url) => url.includes('/auth/v1/user'),
    respond: () => json(200, { id: 'user-1' }),
  },
  {
    match: (url) => url.includes('/rest/v1/configs?key=eq.NEWAPI_URL'),
    respond: () => json(200, [{ value: NEWAPI_URL }]),
  },
  // 其余 configs 键（含 NEWAPI_KEY / ASYNC_IMAGE_MODEL_PATTERN）由 standardRoutes 定制或默认空
  {
    match: (url) => url.includes('/rest/v1/configs'),
    respond: () => json(200, []),
  },
];

/** 默认全套依赖路由：auth/config/rpc */
function standardRoutes(options: {
  configApiKey?: string | null;
  consumeResult?: Record<string, unknown>;
  quotaResult?: Record<string, unknown>;
  upstream?: (url: string, init?: RequestInit) => Response;
  extra?: Route[];
}): Route[] {
  return [
    // NEWAPI_KEY 特定路由需先于 baseRoutes 的通用 configs 路由
    {
      match: (url) => url.includes('/rest/v1/configs?key=eq.NEWAPI_KEY'),
      respond: () =>
        json(
          200,
          options.configApiKey === undefined
            ? [{ value: NEWAPI_KEY }]
            : options.configApiKey === null
              ? []
              : [{ value: options.configApiKey }]
        ),
    },
    ...baseRoutes(),
    ...(options.extra || []),
    {
      match: (url) => url.includes('/rest/v1/rpc/consume_image_quota'),
      respond: () =>
        json(200, options.consumeResult ?? { consumed: true, used: 1, limit: 200, remaining: 199 }),
    },
    {
      match: (url) => url.includes('/rest/v1/rpc/get_image_quota'),
      respond: () =>
        json(200, options.quotaResult ?? { limit: 200, used: 37, remaining: 163, period: '2026-08-01' }),
    },
    {
      match: (url) => url.includes(NEWAPI_URL),
      respond: (url, init) =>
        options.upstream
          ? options.upstream(url, init)
          : json(200, { created: 1700000000, data: [{ url: 'http://img/x.png' }] }),
    },
  ];
}

function makeRequest(pathSuffix = '/v1/images/generations', init: RequestInit = {}): Request {
  return new Request(`http://proxy.local/functions/v1/ai-proxy${pathSuffix}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
    ...init,
  });
}

test('extractBearerToken / isPollingPath 基础行为', () => {
  assert.equal(extractBearerToken('Bearer abc'), 'abc');
  assert.equal(extractBearerToken('basic xyz'), null);
  assert.equal(isPollingPath('/v1/videos/task-123'), true);
  assert.equal(isPollingPath('/mj/task/t9/fetch'), true);
  assert.equal(isPollingPath('/v1/images/generations'), false);
});

test('classifyBilling：n 张计 n、MJ 计 1、视频模型不计费、Gemini 图像模态计 1', () => {
  assert.deepEqual(classifyBilling('POST', '/v1/images/generations', '{"n":4,"model":"gpt-image-2"}'), {
    billable: true,
    mode: 'sync',
    count: 4,
  });
  assert.deepEqual(classifyBilling('POST', '/v1/images/generations', '{"model":"gpt-image-2"}'), {
    billable: true,
    mode: 'sync',
    count: 1,
  });
  assert.equal(classifyBilling('POST', '/mj/submit/imagine', '{"prompt":"a"}').billable, true);
  assert.equal(
    classifyBilling('POST', '/v1/videos', 'model=kling-v2&duration=5', 'image').billable,
    false,
    '视频模型不应计费'
  );
  assert.equal(
    classifyBilling('POST', '/v1/videos', 'model=gemini-3-pro-image-preview&x=1', 'image').billable,
    true,
    '异步图像表单应计费'
  );
  assert.equal(
    classifyBilling('POST', '/v1beta/models/m:streamGenerateContent?alt=sse', JSON.stringify({
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    })).billable,
    true,
    'Gemini 图像模态应计费'
  );
  assert.equal(
    classifyBilling('POST', '/v1beta/models/m:streamGenerateContent?alt=sse', JSON.stringify({
      generationConfig: { responseModalities: ['TEXT'] },
    })).billable,
    false
  );
  // 大写路径兼容（路径匹配对小写化处理），body.n 参与计数
  assert.equal(
    classifyBilling('POST', '/pgc/v1/Images/Generations', '{"n":2}').count,
    2,
    '大小写混用路径也应识别为图像生成并读取 n'
  );
});

test('缺 JWT 返回 401 且不调用上游', async () => {
  const calls: string[] = [];
  const request = new Request('http://proxy.local/functions/v1/ai-proxy/v1/images/generations', {
    method: 'POST',
    body: '{}',
  });
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request,
    pathSuffix: '/v1/images/generations',
    deps: { fetch: routeFetch(baseRoutes(), calls) as typeof fetch },
  });
  assert.equal(response.status, 401);
  assert.ok(!calls.some((c) => c.includes(NEWAPI_URL)));
});

test('无效 JWT 返回 401', async () => {
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequest('/quota'),
    pathSuffix: '/quota',
    deps: {
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).includes('/auth/v1/user')) {
          return new Response('{}', { status: 401 });
        }
        throw new Error('unrouted');
      }) as unknown as typeof fetch,
    },
  });
  assert.equal(response.status, 401);
});

test('配额不足 → 403 quota_exceeded，不调用上游不转发', async () => {
  const calls: string[] = [];
  let consumeCalled = false;
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequest('/v1/images/generations', { body: JSON.stringify({ model: 'gpt-image-2' }) }),
    pathSuffix: '/v1/images/generations',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          consumeResult: { consumed: false, used: 200, limit: 200, remaining: 0 },
          extra: [
            {
              match: (url) => url.includes('consume_image_quota'),
              respond: () => {
                consumeCalled = true;
                return json(200, { consumed: false, used: 200, limit: 200, remaining: 0 });
              },
            },
          ],
        }),
        calls
      ) as typeof fetch,
    },
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(consumeCalled, true);
  assert.ok(!calls.some((c) => c.includes(NEWAPI_URL)), '超额时不应有上游调用');
});

test('同步生图成功：扣减 + 注入 configs.NEWAPI_KEY 转发 + path/body 原样透传', async () => {
  const calls: string[] = [];
  let consumed = false;
  let upstreamAuthHeader = '';
  let upstreamBody = '';
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequest('/v1/images/generations?user=u1', {
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'hello' }),
    }),
    pathSuffix: '/v1/images/generations?user=u1',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          extra: [
            {
              match: (url) => url.includes('consume_image_quota'),
              respond: () => {
                consumed = true;
                return json(200, { consumed: true });
              },
            },
          ],
          upstream: (_url, init) => {
            upstreamAuthHeader = String(
              (init?.headers as Record<string, string>)?.Authorization || ''
            );
            const raw = init?.body;
            upstreamBody =
              typeof raw === 'string'
                ? raw
                : new TextDecoder().decode(new Uint8Array(raw as ArrayBuffer));
            return json(200, { data: [{ url: 'http://img/ok.png' }] }, { 'X-Request-Id': 'rid-1' });
          },
        }),
        calls
      ) as typeof fetch,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(consumed, true);
  assert.equal(upstreamAuthHeader, `Bearer ${NEWAPI_KEY}`);
  assert.equal(upstreamBody, JSON.stringify({ model: 'gpt-image-2', prompt: 'hello' }));
  assert.ok(calls.some((c) => c === `${NEWAPI_URL}/v1/images/generations?user=u1`));
  const payload = await response.json();
  assert.equal(payload.data[0].url, 'http://img/ok.png');
});

test('同步生图上游 500 → 自动退回额度且仍返回上游错误状态', async () => {
  const refunds: string[] = [];
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequest('/v1/images/generations', { body: '{}' }),
    pathSuffix: '/v1/images/generations',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          upstream: () => json(500, { error: 'boom' }),
          extra: [
            {
              match: (url) => url.includes('refund_image_quota'),
              respond: (_url, init) => {
                refunds.push(String(init?.body));
                return json(204, null);
              },
            },
          ],
        }),
        []
      ) as typeof fetch,
    },
  });
  assert.equal(response.status, 500);
  assert.equal(refunds.length, 1);
  const refundArgs = JSON.parse(refunds[0]) as { p_count: number };
  assert.equal(refundArgs.p_count, 1);
});

test('异步图像提交成功 → record_task_bill；随后轮询终态失败 → refund_task_bill 退回', async () => {
  const rpcBodies: Array<Record<string, unknown>> = [];
  const stepOne = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequest('/v1/videos', {
      body: 'model=gpt-image-2-asn&prompt=cute%20cat',
      headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/x-www-form-urlencoded' },
    }),
    pathSuffix: '/v1/videos',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          upstream: () =>
            json(200, { id: 'video-task-77', status: 'submitted' }),
          extra: [
            {
              match: (url) => url.includes('record_task_bill'),
              respond: (_u, init) => {
                rpcBodies.push(JSON.parse(String(init?.body)));
                return json(204, null);
              },
            },
          ],
        }),
        []
      ) as typeof fetch,
    },
  });
  assert.equal(stepOne.status, 200);
  assert.equal(rpcBodies.length, 1);
  assert.equal(rpcBodies[0]['p_upstream_id'], 'video-task-77');
  assert.equal(rpcBodies[0]['p_count'], 1);

  const polls: Array<string> = [];
  const stepTwo = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: new Request('http://proxy.local/functions/v1/ai-proxy/v1/videos/video-task-77', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-jwt' },
    }),
    pathSuffix: '/v1/videos/video-task-77',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          upstream: () => json(200, { id: 'video-task-77', status: 'failed' }),
          extra: [
            {
              match: (url) => url.includes('refund_task_bill'),
              respond: (_u, init) => {
                polls.push(String(init?.body));
                return json(204, null);
              },
            },
          ],
        }),
        []
      ) as typeof fetch,
    },
  });
  assert.equal(stepTwo.status, 200);
  assert.equal(polls.length, 1, '终态失败时应触发一次退回');
  assert.equal(JSON.parse(polls[0])['p_upstream_id'], 'video-task-77');
});

test('polling 终态失败仅在检测到时退回；正常完成不退回', async () => {
  const refunds: string[] = [];
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: new Request('http://proxy.local/functions/v1/ai-proxy/mj/task/t9/fetch', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-jwt' },
    }),
    pathSuffix: '/mj/task/t9/fetch',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          upstream: () => json(200, { code: 1, result: '%50', status: 'SUCCESS' }),
          extra: [
            {
              match: (url) => url.includes('refund_task_bill'),
              respond: (_u, init) => {
                refunds.push(String(init?.body));
                return json(204, null);
              },
            },
          ],
        }),
        []
      ) as typeof fetch,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(refunds.length, 0, 'SUCCESS 状态不应退回');
});

test('detectTerminalFailure 支持多种字段与大小写', () => {
  assert.equal(detectTerminalFailure({ status: 'FAILED' }), true);
  assert.equal(detectTerminalFailure({ state: 'cancelled' }), true);
  assert.equal(detectTerminalFailure({ data: { task_status: 'success' } }), false);
  assert.equal(detectTerminalFailure(null), false);
});

test('quota 端点：JWT 有效时返回剩余额度', async () => {
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: new Request('http://proxy.local/functions/v1/ai-proxy/quota', {
      headers: { Authorization: 'Bearer test-jwt' },
    }),
    pathSuffix: '/quota',
    deps: {
      fetch: routeFetch(standardRoutes({ quotaResult: { limit: 200, used: 37, remaining: 163 } }), []) as typeof fetch,
    },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.quota.remaining, 163);
});

test('configs.NEWAPI_KEY 缺失 → 503 且不调用上游', async () => {
  const calls: string[] = [];
  const routes = standardRoutes({ configApiKey: null });
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequest('/v1/models'),
    pathSuffix: '/v1/models',
    deps: { fetch: routeFetch(routes, calls) as typeof fetch },
  });
  assert.equal(response.status, 503);
  assert.ok(!calls.some((c) => c.includes(NEWAPI_URL)), '无密钥时不应调用上游');
});

// ============================================================
// 响应归档（upstream_response 落库）集成测试
// ============================================================

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** 归档相关 mock：user_profiles / storage 上传 / task_submissions 写库 */
function archiveRoutes(options: {
  uploads?: string[];
  rows?: Array<Record<string, unknown>>;
  failUpload?: boolean;
} = {}): Route[] {
  return [
    {
      match: (url) => url.includes('/rest/v1/user_profiles'),
      respond: () => json(200, [{ oa_account: 'zhangsan' }]),
    },
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
      match: (url) => url.includes('/rest/v1/task_submissions'),
      respond: (_url, init) => {
        options.rows?.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(201, null);
      },
    },
  ];
}

function makeRequestWithTaskId(
  pathSuffix: string,
  taskId: string,
  init: RequestInit = {}
): Request {
  return new Request(`http://proxy.local/functions/v1/ai-proxy${pathSuffix}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-jwt',
      'Content-Type': 'application/json',
      'x-task-id': taskId,
    },
    ...init,
  });
}

test('同步生图成功且带 x-task-id → 响应归档：b64 转存 bucket、JSON 内替换、透传响应不变', async () => {
  const uploads: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequestWithTaskId('/v1/images/generations', 'task-1', {
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'hello' }),
    }),
    pathSuffix: '/v1/images/generations',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          extra: [
            ...archiveRoutes({ uploads, rows }),
            {
              match: (url) => url.includes('consume_image_quota'),
              respond: () => json(200, { consumed: true }),
            },
          ],
          upstream: () =>
            json(200, {
              created: 1,
              data: [{ b64_json: TINY_PNG_B64, revised_prompt: 'x' }],
            }),
        }),
        []
      ) as typeof fetch,
    },
  });

  // 透传给前端的响应必须保持上游原样（b64 仍在），不能把路径透给前端适配器
  assert.equal(response.status, 200);
  const passthrough = (await response.json()) as any;
  assert.equal(passthrough.data[0].b64_json, TINY_PNG_B64);

  // 归档：上传 1 个文件 + 写库 1 行，JSON 内替换为存储路径
  assert.equal(uploads.length, 1);
  assert.match(uploads[0], /^zhangsan\/\d{4}-\d{2}-\d{2}\/output-[0-9a-f]{64}\.png$/);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row['user_id'], 'user-1');
  assert.equal(row['task_id'], 'task-1');
  assert.equal((row['upstream_response'] as any).data[0].b64_json, uploads[0]);
  assert.deepEqual(row['response_file_paths'], [uploads[0]]);
});

test('同步生图成功但无 x-task-id → 不归档', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequest('/v1/images/generations', {
      body: JSON.stringify({ model: 'gpt-image-2' }),
    }),
    pathSuffix: '/v1/images/generations',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          extra: [
            ...archiveRoutes({ rows }),
            {
              match: (url) => url.includes('consume_image_quota'),
              respond: () => json(200, { consumed: true }),
            },
          ],
          upstream: () => json(200, { data: [{ b64_json: TINY_PNG_B64 }] }),
        }),
        []
      ) as typeof fetch,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(rows.length, 0);
});

test('上游 ≥400 且带 x-task-id → 错误 JSON 归档、状态透传、退回额度', async () => {
  const refunds: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequestWithTaskId('/v1/images/generations', 'task-2', {
      body: JSON.stringify({ model: 'gpt-image-2' }),
    }),
    pathSuffix: '/v1/images/generations',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          extra: [
            ...archiveRoutes({ rows }),
            {
              match: (url) => url.includes('refund_image_quota'),
              respond: (_u, init) => {
                refunds.push(String(init?.body));
                return json(204, null);
              },
            },
          ],
          upstream: () =>
            json(400, {
              error: {
                message: '预扣费额度失败, 用户剩余额度: ＄0.008202, 需要预扣费额度: ＄0.156300',
              },
            }),
        }),
        []
      ) as typeof fetch,
    },
  });

  assert.equal(response.status, 400);
  const passthrough = (await response.json()) as any;
  assert.match(passthrough.error.message, /预扣费额度失败/);
  assert.equal(refunds.length, 1, '失败响应应退回额度');
  assert.equal(rows.length, 1, '失败响应也应归档');
  assert.match((rows[0]['upstream_response'] as any).error.message, /预扣费额度失败/);
});

test('轮询终态成功且带 x-task-id → 归档，不退回', async () => {
  const refunds: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: new Request('http://proxy.local/functions/v1/ai-proxy/mj/task/t9/fetch', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-jwt', 'x-task-id': 'task-3' },
    }),
    pathSuffix: '/mj/task/t9/fetch',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          extra: [
            ...archiveRoutes({ rows }),
            {
              match: (url) => url.includes('refund_task_bill'),
              respond: (_u, init) => {
                refunds.push(String(init?.body));
                return json(204, null);
              },
            },
          ],
          upstream: () => json(200, { status: 'SUCCESS', result: '%50' }),
        }),
        []
      ) as typeof fetch,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(refunds.length, 0, 'SUCCESS 不应退回');
  assert.equal(rows.length, 1, '终态成功应归档');
  assert.equal((rows[0]['upstream_response'] as any).status, 'SUCCESS');
});

test('轮询非终态（processing）→ 不归档', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: new Request('http://proxy.local/functions/v1/ai-proxy/v1/videos/v-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-jwt', 'x-task-id': 'task-4' },
    }),
    pathSuffix: '/v1/videos/v-1',
    deps: {
      fetch: routeFetch(
        standardRoutes({ extra: archiveRoutes({ rows }), upstream: () => json(200, { status: 'processing', progress: 40 }) }),
        []
      ) as typeof fetch,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(rows.length, 0);
});

test('异步提交响应（非终态）→ 不归档，仅记账', async () => {
  const rpcBodies: Array<Record<string, unknown>> = [];
  const rows: Array<Record<string, unknown>> = [];
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequestWithTaskId('/v1/videos', 'task-5', {
      body: 'model=gemini-3-pro-image-preview&prompt=cute%20cat',
      headers: {
        Authorization: 'Bearer test-jwt',
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-task-id': 'task-5',
      },
    }),
    pathSuffix: '/v1/videos',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          extra: [
            ...archiveRoutes({ rows }),
            {
              match: (url) => url.includes('record_task_bill'),
              respond: (_u, init) => {
                rpcBodies.push(JSON.parse(String(init?.body)));
                return json(204, null);
              },
            },
          ],
          upstream: () => json(200, { id: 'v-submit-9', status: 'submitted' }),
        }),
        []
      ) as typeof fetch,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(rpcBodies.length, 1, '提交响应仍应记账');
  assert.equal(rows.length, 0, '非终态提交响应不归档');
});

test('上游非 JSON 错误 + 带 x-task-id → 不归档、状态透传', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const response = await handleAiProxyRequest({
    env: { SUPABASE_URL: SUPABASE_URL, SERVICE_ROLE_KEY: SRK },
    request: makeRequestWithTaskId('/v1/images/generations', 'task-6', {
      body: JSON.stringify({ model: 'gpt-image-2' }),
    }),
    pathSuffix: '/v1/images/generations',
    deps: {
      fetch: routeFetch(
        standardRoutes({
          extra: archiveRoutes({ rows }),
          upstream: () =>
            new Response('internal server error', {
              status: 502,
              headers: { 'Content-Type': 'text/plain' },
            }),
        }),
        []
      ) as typeof fetch,
    },
  });
  assert.equal(response.status, 502);
  assert.equal(rows.length, 0, '非 JSON 响应不归档');
});

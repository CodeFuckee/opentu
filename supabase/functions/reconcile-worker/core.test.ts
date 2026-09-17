/**
 * reconcile-worker 单测（node:test）
 *
 * 覆盖：锚定匹配、tuzi URL 提取、无任务轻量轮、链式间隔跳过、
 * 锁占用跳过、熔断与手动恢复、完整救回流（下载→转存→置完成→补扣）。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runTick,
  match,
  extractTuziUrls,
  usd,
  type Task,
  type UpLog,
  type WorkerEnv,
} from './core.ts';

const ENV: WorkerEnv = {
  supabaseUrl: 'http://supabase.local',
  serviceRoleKey: 'srk-test',
};

interface MockState {
  state: {
    id: number; running: boolean; last_completed_at: string | null;
    consecutive_errors: number; circuit_open: boolean;
  };
  configs: Record<string, string>;
  taskRows: Record<string, unknown>[];
  taskPatches: Record<string, unknown>[];
  newapiLogRows: Record<string, unknown>[];
  tuziLogRows: Record<string, unknown>[];
  rpcCalls: string[];
  storagePuts: string[];
  dingtalkPosts: string[];
  nowS: number;
}

let mock: MockState;
let originalFetch: typeof fetch;

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyText = typeof init?.body === 'string' ? init.body : '';

    if (url.startsWith('http://supabase.local/rest/v1/configs')) {
      if (method === 'DELETE') {
        const key = decodeURIComponent(url.split('key=eq.')[1] ?? '');
        delete mock.configs[key];
        return new Response(null, { status: 204 });
      }
      return jsonResp(
        Object.entries(mock.configs).map(([key, value]) => ({ key, value })),
      );
    }
    if (url.includes('/rest/v1/reconcile_state')) {
      if (method === 'GET') return jsonResp([mock.state]);
      const body = JSON.parse(bodyText || '{}') as Record<string, unknown>;
      if (body.running === true) {
        if (mock.state.running) return jsonResp([], 200);
        mock.state.running = true;
        return jsonResp([mock.state]);
      }
      // release / error 计数 / 熔断更新
      if (typeof body.consecutive_errors === 'number') {
        mock.state.consecutive_errors = body.consecutive_errors as number;
        mock.state.circuit_open = body.circuit_open as boolean;
      }
      mock.state.running = false;
      if (typeof body.last_completed_at === 'string') {
        mock.state.last_completed_at = body.last_completed_at;
      }
      return new Response(null, { status: 204 });
    }
    if (url.includes('/rest/v1/rpc/')) {
      const rpcName = url.includes('consume_image_quota') ? 'consume' : 'refund';
      mock.rpcCalls.push(rpcName);
      return jsonResp({ consumed: rpcName === 'consume' });
    }
    if (url.includes('/rest/v1/task_submissions')) {
      if (method === 'PATCH') {
        const body = JSON.parse(bodyText) as Record<string, unknown>;
        mock.taskPatches.push(body);
        return new Response(null, { status: 204 });
      }
      return jsonResp(mock.taskRows);
    }
    if (url.startsWith('http://newapi.local:3000/api/log/')) {
      return jsonResp({ data: { items: mock.newapiLogRows } });
    }
    if (url.startsWith('https://api.tu-zi.com/api/log/self')) {
      return jsonResp({ data: { items: mock.tuziLogRows } });
    }
    if (url.startsWith('http://oss.local/')) {
      return new Response(PNG, { status: 200 });
    }
    if (url.includes('/storage/v1/object/huabu/')) {
      if (method === 'PUT') {
        mock.storagePuts.push(url);
        return jsonResp({ Key: 'huabu/x' });
      }
      return new Response(null, { status: 404 });
    }
    if (url.startsWith('https://oapi.dingtalk.com/')) {
      mock.dingtalkPosts.push(bodyText);
      return jsonResp({ errcode: 0 });
    }
    return new Response('unrouted', { status: 404 });
  }) as typeof fetch;
}

function baseTask(over: Partial<Task> = {}): Task {
  const nowS = mock.nowS;
  return {
    taskId: 'aaaa-1',
    userId: 'user-1',
    status: 'failed',
    model: 'test-model',
    n: 1,
    created: nowS - 600,
    ended: nowS - 300,
    reconciled: false,
    reconcileAction: '',
    err: '',
    logs: [],
    ...over,
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mock = {
    state: {
      id: 1, running: false, last_completed_at: null,
      consecutive_errors: 0, circuit_open: false,
    },
    configs: {
      NEWAPI_URL: 'http://newapi.local:3000',
      NEWAPI_ACCESS_TOKEN: 'tok-newapi',
      NEWAPI_USER_ID: '2',
      TUZI_ACCESS_TOKEN: 'tok-tuzi',
      TUZI_USER_ID: '49031',
      DEV_DINGTALK_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?x=1',
    },
    taskRows: [],
    taskPatches: [],
    newapiLogRows: [],
    tuziLogRows: [],
    rpcCalls: [],
    storagePuts: [],
    dingtalkPosts: [],
    nowS: 1_800_000_000,
  };
  globalThis.fetch = makeFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------- 纯函数 ----------
test('match: 同模型且上游开始时间落在任务区间内才配对', () => {
  const t1 = baseTask({ taskId: 't1', created: 1000, ended: 1200 });
  const t2 = baseTask({ taskId: 't2', model: 'other', created: 1000, ended: 1200 });
  const tasks = [t1, t2];
  const logs: UpLog[] = [
    { logId: 1, billAt: 1180, useTime: 60, model: 'test-model', quota: 38,
      upstreamRequestId: 'req-1', start: 1120 },
    { logId: 2, billAt: 1190, useTime: 60, model: 'other', quota: 1,
      upstreamRequestId: 'req-2', start: 1130 },
  ];
  match(tasks, logs);
  assert.equal(t1.logs.length, 1);
  assert.equal(t1.logs[0].logId, 1);
  assert.equal(t2.logs.length, 1);
  assert.equal(t2.logs[0].logId, 2);
});

test('match: 开始时间早于任务创建超容差不配对', () => {
  const t1 = baseTask({ taskId: 't1', created: 1000, ended: 1200 });
  match([t1], [
    { logId: 1, billAt: 1100, useTime: 200, model: 'test-model', quota: 1,
      upstreamRequestId: 'r', start: 900 },
  ]);
  assert.equal(t1.logs.length, 0);
});

test('extractTuziUrls: entries / urls / 单值 / 坏 JSON', () => {
  const viaEntries = extractTuziUrls(JSON.stringify({
    generated_image_delivery: { entries: [{ url: 'http://o/1.png' }] },
  }));
  assert.deepEqual(viaEntries, ['http://o/1.png']);
  const viaList = extractTuziUrls(JSON.stringify({
    generated_image_urls: ['http://o/2.png', 'bad'],
  }));
  assert.deepEqual(viaList, ['http://o/2.png']);
  const viaSingle = extractTuziUrls(JSON.stringify({
    generated_image_url: 'http://o/3.png',
  }));
  assert.deepEqual(viaSingle, ['http://o/3.png']);
  assert.deepEqual(extractTuziUrls('{broken'), []);
});

test('usd: 按 500000 折算', () => {
  assert.equal(usd(500000), '$1.00');
  assert.equal(usd(0), '$0.00');
});

// ---------- runTick ----------
test('runTick: 无目标 → no_work 且登记完成时间', async () => {
  const result = await runTick(ENV);
  assert.equal(result.status, 'no_work');
  assert.ok(mock.state.last_completed_at, 'last_completed_at 应被登记');
  assert.equal(mock.state.running, false, '锁应释放');
});

test('runTick: 距上次完成不足 5 分钟 → skip_interval', async () => {
  mock.state.last_completed_at = new Date((mock.nowS - 60) * 1000).toISOString();
  const result = await runTick(ENV);
  assert.equal(result.status, 'skip_interval');
  assert.equal(mock.state.running, false);
});

test('runTick: 上一轮未结束 → skip_lock', async () => {
  mock.state.running = true;
  const result = await runTick(ENV);
  assert.equal(result.status, 'skip_lock');
});

test('runTick: 熔断中跳过，RECONCILE_RESUME=true 恢复', async () => {
  mock.state.circuit_open = true;
  const blocked = await runTick(ENV);
  assert.equal(blocked.status, 'skip_circuit');

  mock.configs.RECONCILE_RESUME = 'true';
  const resumed = await runTick(ENV);
  assert.equal(['no_work', 'ran'].includes(resumed.status), true);
  assert.equal(mock.state.circuit_open, false);
  assert.equal(mock.configs.RECONCILE_RESUME, undefined,
    '恢复标志应被一次性消费');
});

test('runTick: 有目标且 tuzi 有留存 → 恢复+补扣+通知', async () => {
  const t = baseTask({
    status: 'failed',
    reconcileAction: 'quota_refunded',
    error: { reconciled: { action: 'quota_refunded' } },
  });
  mock.taskRows = [{
    task_id: t.taskId, user_id: t.userId, type: 'image', status: 'failed',
    model: t.model, n: 1,
    created_at: new Date(t.created * 1000).toISOString(),
    completed_at: new Date(t.ended * 1000).toISOString(),
    updated_at: new Date(t.ended * 1000).toISOString(),
    error: { reconciled: { action: 'quota_refunded' } },
    reconcile_action: 'quota_refunded',
  }];
  mock.newapiLogRows = [{
    id: 1, created_at: t.ended - 20, use_time: 30,
    model_name: 'test-model', quota: 500000,
    username: 'chenkaidi', token_name: 'huabu',
    upstream_request_id: 'req-abc',
  }];
  mock.tuziLogRows = [{
    id: 9, request_id: 'req-abc',
    other: JSON.stringify({
      generated_image_delivery: {
        entries: [{ url: 'http://oss.local/img.png' }],
      },
    }),
  }];

  const result = await runTick(ENV);
  assert.equal(result.status, 'ran');
  const patch = mock.taskPatches.find((p) => p.status === 'completed');
  assert.ok(patch, '应有置 completed 的 PATCH');
  const resultJson = patch.result as { url: string; reconciled: Record<string, unknown> };
  assert.equal(resultJson.url, 'http://oss.local/img.png');
  assert.equal(resultJson.reconciled.quota_recharged, true);
  assert.equal(patch.error, null);
  assert.deepEqual(mock.rpcCalls, ['consume']);
  assert.equal(mock.storagePuts.length, 1);
  assert.ok(mock.dingtalkPosts.length >= 1, '有动作应推钉钉');
});

test('runTick: NEWAPI 凭证为占位值 → not_configured', async () => {
  mock.configs.NEWAPI_ACCESS_TOKEN = 'PENDING_FILL';
  const result = await runTick(ENV);
  assert.equal(result.status, 'not_configured');
  assert.equal(mock.state.running, false);
});

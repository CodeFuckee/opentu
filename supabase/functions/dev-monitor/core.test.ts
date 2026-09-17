/**
 * dev-monitor Edge Function 单测（node:test，mock fetch，模式与 dashboard-stats 一致）
 *
 * 覆盖：
 * - aggregatePipeline：状态计数/成功率分母/卡死阈值按类型/按模型失败/按天趋势/耗时分位
 * - summarizeError / toFailureSamples / toStuckList：error 摘要与 OA 归属
 * - probeHealth：并行探测、401=存活、GoTrue 降级、网关缺配置=未配置、超时=down
 * - verifyDevAdmin：无/无效 token 401、非管理员与 RPC 失败 403、放行带调用者 JWT
 * - buildDevMonitorHtml：自包含页面、登录壳、自动刷新、区块齐全、不泄露 service_role
 * - aggregateStatus：编排（窗口行/失败样本/花名册/探测并行）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePipeline,
  aggregateStatus,
  buildDevMonitorHtml,
  probeHealth,
  stuckThresholdMs,
  summarizeError,
  toFailureSamples,
  toStuckList,
  verifyDevAdmin,
  type DevMonitorEnv,
} from './core.ts';

const ANON_KEY = 'test-anon-key';

const ENV: DevMonitorEnv = {
  SUPABASE_URL: 'http://supabase.local',
  SERVICE_ROLE_KEY: 'service-role-key',
  ANON_KEY,
};

type Route = {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response;
};

function routeFetch(routes: Route[], calls: string[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

// ============================================================
// aggregatePipeline：状态计数/成功率/卡死/按模型失败/天趋势/分位
// ============================================================

test('aggregatePipeline：状态计数与成功率分母（cancelled 单列，卡死不计入分母）', () => {
  const rows = [
    { type: 'image', status: 'completed', created_at: '2026-09-15T01:00:00Z', completed_at: '2026-09-15T01:00:20Z', model: 'm-a' },
    { type: 'image', status: 'completed', created_at: '2026-09-15T02:00:00Z', completed_at: '2026-09-15T02:01:00Z', model: 'm-b' },
    { type: 'image', status: 'failed', created_at: '2026-09-15T03:00:00Z', completed_at: '2026-09-15T03:00:30Z', model: 'm-a' },
    { type: 'chat', status: 'cancelled', created_at: '2026-09-15T04:00:00Z', completed_at: null, model: 'm-c' },
    // 卡死：submitted 且远早于阈值（image 10 分钟）
    { type: 'image', status: 'submitted', created_at: '2020-01-01T00:00:00Z', completed_at: null, model: 'm-a' },
    // 刚提交的 submitted 不算卡死
    { type: 'image', status: 'submitted', created_at: new Date(Date.now() - 60_000).toISOString(), completed_at: null, model: 'm-a' },
  ] as never;

  const stats = aggregatePipeline(rows);
  assert.equal(stats.counts.completed, 2);
  assert.equal(stats.counts.failed, 1);
  assert.equal(stats.counts.cancelled, 1);
  assert.equal(stats.counts.stuck, 1);
  // 分母 = completed+failed+cancelled = 4 → 2/4 = 0.5
  assert.equal(stats.successRate, 0.5);
});

test('aggregatePipeline：分母为 0 时成功率为 null；空行全零', () => {
  const onlyStuck = aggregatePipeline([
    { type: 'image', status: 'submitted', created_at: '2020-01-01T00:00:00Z', completed_at: null, model: 'm-a' },
  ] as never);
  assert.equal(onlyStuck.successRate, null);
  assert.equal(onlyStuck.counts.submitted, 1);
  assert.equal(onlyStuck.counts.stuck, 1);

  const empty = aggregatePipeline([]);
  assert.equal(empty.successRate, null);
  assert.equal(empty.counts.completed, 0);
  assert.equal(empty.counts.failed, 0);
  assert.deepEqual(empty.daily, []);
  assert.deepEqual(empty.failuresByModel, []);
});

test('stuckThresholdMs：image 10 分钟、video 30 分钟、其余 10 分钟', () => {
  assert.equal(stuckThresholdMs('image'), 10 * 60_000);
  assert.equal(stuckThresholdMs('video'), 30 * 60_000);
  assert.equal(stuckThresholdMs('audio'), 10 * 60_000);
  assert.equal(stuckThresholdMs('chat'), 10 * 60_000);
  assert.equal(stuckThresholdMs('unknown'), 10 * 60_000);
});

test('aggregatePipeline：视频卡死阈值 30 分钟（10 分钟不算，31 分钟算）', () => {
  const elevenMinAgo = new Date(Date.now() - 11 * 60_000).toISOString();
  const thirtyOneMinAgo = new Date(Date.now() - 31 * 60_000).toISOString();
  const stats = aggregatePipeline([
    { type: 'video', status: 'submitted', created_at: elevenMinAgo, completed_at: null, model: 'v' },
    { type: 'video', status: 'submitted', created_at: thirtyOneMinAgo, completed_at: null, model: 'v' },
    { type: 'audio', status: 'submitted', created_at: elevenMinAgo, completed_at: null, model: 'a' },
  ] as never);
  assert.equal(stats.counts.submitted, 3);
  assert.equal(stats.counts.stuck, 2); // 视频 31 分钟 + 音频 11 分钟
});

test('aggregatePipeline：按模型失败排行（含成功总数与失败率），按失败数降序', () => {
  const rows = [
    { type: 'image', status: 'failed', created_at: '2026-09-15T01:00:00Z', completed_at: null, model: 'm-a' },
    { type: 'image', status: 'failed', created_at: '2026-09-15T01:01:00Z', completed_at: null, model: 'm-a' },
    { type: 'image', status: 'failed', created_at: '2026-09-15T01:02:00Z', completed_at: null, model: 'm-b' },
    { type: 'image', status: 'completed', created_at: '2026-09-15T02:00:00Z', completed_at: '2026-09-15T02:00:10Z', model: 'm-b' },
    { type: 'image', status: 'completed', created_at: '2026-09-15T02:01:00Z', completed_at: '2026-09-15T02:01:10Z', model: 'm-c' },
  ] as never;
  const stats = aggregatePipeline(rows);
  assert.deepEqual(stats.failuresByModel, [
    { model: 'm-a', failed: 2, total: 2, rate: 1 },
    { model: 'm-b', failed: 1, total: 2, rate: 0.5 },
    { model: 'm-c', failed: 0, total: 1, rate: 0 },
  ]);
});

test('aggregatePipeline：按天趋势按东八区切日（total=全部归档，failed=其中失败）', () => {
  const rows = [
    // UTC 2026-09-14T00:00Z → 东八区 09-14 08:00
    { type: 'image', status: 'completed', created_at: '2026-09-14T00:00:00Z', completed_at: '2026-09-14T00:00:10Z', model: 'm-a' },
    // UTC 16:30 → 东八区次日 09-15 00:30
    { type: 'image', status: 'failed', created_at: '2026-09-14T16:30:00Z', completed_at: null, model: 'm-a' },
    { type: 'image', status: 'completed', created_at: '2026-09-15T01:00:00Z', completed_at: '2026-09-15T01:00:10Z', model: 'm-a' },
    { type: 'image', status: 'failed', created_at: '2026-09-15T08:00:00Z', completed_at: '2026-09-15T08:00:10Z', model: 'm-a' },
  ] as never;
  const stats = aggregatePipeline(rows);
  assert.deepEqual(stats.daily, [
    { date: '2026-09-14', total: 1, failed: 0 },
    { date: '2026-09-15', total: 3, failed: 2 },
  ]);
});

test('aggregatePipeline：出图耗时分位 p50/p95（completed 且双时间戳，按 type 拆）', () => {
  const base = Date.UTC(2026, 8, 15, 0, 0, 0);
  const rows = Array.from({ length: 20 }, (_, i) => ({
    type: 'image',
    status: 'completed',
    created_at: new Date(base + i * 60_000).toISOString(),
    completed_at: new Date(base + i * 60_000 + (10 + i) * 1000).toISOString(),
    model: 'm-a',
  }));
  rows.push({ type: 'video', status: 'completed', created_at: new Date(base).toISOString(), completed_at: new Date(base + 120_000).toISOString(), model: 'v' });
  // failed 不计入耗时
  rows.push({ type: 'image', status: 'failed', created_at: new Date(base).toISOString(), completed_at: new Date(base + 999_000).toISOString(), model: 'm-a' });

  const stats = aggregatePipeline(rows as never);
  const image = stats.durationByType.image;
  assert.equal(image.count, 20);
  // 耗时 10..29s 排序后 p50 = 第 10 个 = 19s，p95 = 第 19 个 = 28s
  assert.equal(image.p50Ms, 19000);
  assert.equal(image.p95Ms, 28000);
  const video = stats.durationByType.video;
  assert.equal(video.count, 1);
  assert.equal(video.p50Ms, 120000);
});

// ============================================================
// summarizeError / toFailureSamples / toStuckList
// ============================================================

test('summarizeError：message 优先、error 字符串次之、对象 JSON 截断、空值空串', () => {
  assert.equal(summarizeError({ message: 'boom' }), 'boom');
  assert.equal(summarizeError({ error: 'bad gateway' }), 'bad gateway');
  assert.equal(summarizeError('plain string'), 'plain string');
  assert.equal(summarizeError({ code: 500, detail: 'x' }), '{"code":500,"detail":"x"}');
  assert.equal(summarizeError(null), '');
  assert.equal(summarizeError(undefined), '');
  assert.equal(summarizeError({}), '');
  const long = 'x'.repeat(300);
  const cut = summarizeError({ message: long });
  assert.equal(cut.length, 200);
});

test('toFailureSamples：OA 归属、耗时与错误摘要；花名册外 oa 为 null', () => {
  const rows = [
    {
      user_id: 'u1', type: 'image', status: 'failed',
      created_at: '2026-09-15T01:00:00Z', completed_at: '2026-09-15T01:00:30Z',
      model: 'm-a', error: { message: 'upstream 500' },
    },
    {
      user_id: 'u2', type: 'video', status: 'failed',
      created_at: '2026-09-15T02:00:00Z', completed_at: null,
      model: 'v', error: null,
    },
  ] as never;
  const samples = toFailureSamples(rows, new Map([['u1', 'alice']]));
  assert.deepEqual(samples[0], {
    createdAt: '2026-09-15T01:00:00Z',
    oa: 'alice',
    type: 'image',
    model: 'm-a',
    durationMs: 30000,
    errorSummary: 'upstream 500',
  });
  assert.equal(samples[1].oa, null);
  assert.equal(samples[1].durationMs, null);
  assert.equal(samples[1].errorSummary, '');
});

test('toStuckList：按等待时长倒序，携带阈值；非卡死不进列表', () => {
  const rows = [
    { user_id: 'u1', type: 'image', status: 'completed', created_at: '2020-01-01T00:00:00Z', completed_at: '2020-01-01T00:00:10Z', model: 'm-a' },
    { user_id: 'u1', type: 'image', status: 'submitted', created_at: '2020-01-01T00:00:00Z', completed_at: null, model: 'm-a' },
    { user_id: 'u2', type: 'video', status: 'submitted', created_at: '2020-01-01T00:00:00Z', completed_at: null, model: 'v' },
  ] as never;
  const now = Date.UTC(2020, 0, 1, 1, 0, 0); // 提交后 1 小时
  const list = toStuckList(rows, new Map([['u1', 'alice']]), now);
  assert.equal(list.length, 2);
  // 视频（30 分钟阈值）等待 60 分钟 > 图片 60 分钟 —— 等待相同，先比等待时长
  assert.equal(list[0].waitedMs, 3600_000);
  assert.equal(list[1].waitedMs, 3600_000);
  assert.equal(list.find((s) => s.type === 'video')?.thresholdMs, 30 * 60_000);
  assert.equal(list.find((s) => s.type === 'image')?.oa, 'alice');
});

// ============================================================
// probeHealth：并行探测 / 401=存活 / GoTrue 降级 / 网关缺配置 / 超时
// ============================================================

test('probeHealth：六项探测全部存活（ai-proxy 401=存活，网关令牌有效）', async () => {
  const fetchImpl = routeFetch(
    [
      { match: (u) => u.includes('/rest/v1/task_submissions?select=id&limit=1'), respond: () => json(200, []) },
      { match: (u) => u.includes('/auth/v1/health'), respond: () => json(200, { version: 'v2' }) },
      { match: (u) => u.includes('/storage/v1/status'), respond: () => json(200, {}) },
      { match: (u) => u.includes('/functions/v1/ai-proxy/quota'), respond: () => json(401, { error: 'unauthorized' }) },
      { match: (u) => u.includes('/rest/v1/configs?key=eq.NEWAPI_URL'), respond: () => json(200, [{ value: 'http://gw.local' }]) },
      { match: (u) => u.includes('/rest/v1/configs?key=eq.NEWAPI_TOKEN'), respond: () => json(200, [{ value: 'admintok' }]) },
      { match: (u) => u.includes('/api/status'), respond: () => json(200, { success: true }) },
      { match: (u) => u.includes('/api/token/'), respond: () => json(200, { data: { items: [] } }) },
    ],
    []
  );
  const probes = await probeHealth(ENV, { fetch: fetchImpl });
  assert.equal(probes.length, 6);
  for (const p of probes) {
    assert.equal(p.ok, true, `probe ${p.name} should be ok: ${JSON.stringify(p)}`);
    assert.ok(p.latencyMs >= 0);
  }
  assert.deepEqual(
    probes.map((p) => p.name),
    ['PostgREST', 'GoTrue 认证', 'Storage', 'ai-proxy 函数', 'New API 网关', '网关管理令牌']
  );
});

test('probeHealth：GoTrue /health 404 时回退 /auth/v1/settings；网关令牌无效=down', async () => {
  const calls: string[] = [];
  const fetchImpl = routeFetch(
    [
      { match: (u) => u.includes('/rest/v1/task_submissions?select=id&limit=1'), respond: () => json(200, []) },
      { match: (u) => u.includes('/auth/v1/health'), respond: () => json(404, {}) },
      { match: (u) => u.includes('/auth/v1/settings'), respond: () => json(200, {}) },
      { match: (u) => u.includes('/storage/v1/status'), respond: () => json(200, {}) },
      { match: (u) => u.includes('/functions/v1/ai-proxy/quota'), respond: () => json(401, {}) },
      { match: (u) => u.includes('/rest/v1/configs?key=eq.NEWAPI_URL'), respond: () => json(200, [{ value: 'http://gw.local' }]) },
      { match: (u) => u.includes('/rest/v1/configs?key=eq.NEWAPI_TOKEN'), respond: () => json(200, [{ value: 'admintok' }]) },
      { match: (u) => u.includes('/api/status'), respond: () => json(200, { success: true }) },
      { match: (u) => u.includes('/api/token/'), respond: () => json(401, { message: 'invalid token' }) },
    ],
    calls
  );
  const probes = await probeHealth(ENV, { fetch: fetchImpl });
  assert.ok(calls.some((u) => u.includes('/auth/v1/settings')), '应回退 settings');
  const token = probes.find((p) => p.name === '网关管理令牌');
  assert.equal(token?.ok, false);
  const goalive = probes.find((p) => p.name === 'GoTrue 认证');
  assert.equal(goalive?.ok, true);
});

test('probeHealth：网关配置缺失 → 未配置（ok=null）；PostgREST 宕机 → down', async () => {
  const fetchImpl = routeFetch(
    [
      // PostgREST 网络不可达（unrouted fetch 会 throw，routeFetch 之外处理为 down）
      { match: (u) => u.includes('/rest/v1/task_submissions?select=id&limit=1'), respond: () => json(200, []) },
      { match: (u) => u.includes('/auth/v1/health'), respond: () => json(200, {}) },
      { match: (u) => u.includes('/storage/v1/status'), respond: () => json(200, {}) },
      { match: (u) => u.includes('/functions/v1/ai-proxy/quota'), respond: () => json(401, {}) },
      { match: (u) => u.includes('/rest/v1/configs'), respond: () => json(200, []) },
    ],
    []
  );
  const probes = await probeHealth(ENV, { fetch: fetchImpl });
  const gw = probes.find((p) => p.name === 'New API 网关');
  const gwToken = probes.find((p) => p.name === '网关管理令牌');
  assert.equal(gw?.ok, null);
  assert.ok((gw?.detail || '').includes('缺少 NEWAPI_URL'));
  assert.equal(gwToken?.ok, null);
  assert.ok((gwToken?.detail || '').includes('NEWAPI_TOKEN'));
  const rest = probes.find((p) => p.name === 'PostgREST');
  assert.equal(rest?.ok, true);
});

test('probeHealth：端点超时 → ok=false 且标记 timeout（不拖垮其余探测）', async () => {
  const slowFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/rest/v1/task_submissions?select=id&limit=1')) {
      await new Promise((r) => setTimeout(r, 200));
      // 模拟真实 fetch 对 abort signal 的响应：中止后以 AbortError 拒绝
      if (init?.signal?.aborted) {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }
      return json(200, []);
    }
    if (url.includes('/auth/v1/health')) return json(200, {});
    if (url.includes('/storage/v1/status')) return json(200, {});
    if (url.includes('/functions/v1/ai-proxy/quota')) return json(401, {});
    if (url.includes('/rest/v1/configs')) return json(200, []);
    throw new Error('unrouted: ' + url);
  };
  const probes = await probeHealth(ENV, { fetch: slowFetch }, { timeoutMs: 50 });
  const rest = probes.find((p) => p.name === 'PostgREST');
  assert.equal(rest?.ok, false);
  assert.equal(rest?.status, 'timeout');
  const goalive = probes.find((p) => p.name === 'GoTrue 认证');
  assert.equal(goalive?.ok, true);
});

// ============================================================
// verifyDevAdmin（与 dashboard-stats 门禁同语义）
// ============================================================

function gateRequest(token?: string) {
  return new Request('http://x/functions/v1/dev-monitor/status', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function gateMockFetch(opts: { authOk?: boolean; rpcBody?: string; rpcStatus?: number } = {}) {
  const authOk = opts.authOk ?? true;
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/v1/user')) {
      return new Response(authOk ? JSON.stringify({ id: 'u1' }) : '{}', { status: authOk ? 200 : 401 });
    }
    if (url.includes('/rest/v1/rpc/is_admin')) {
      return new Response(opts.rpcBody ?? 'true', { status: opts.rpcStatus ?? 200 });
    }
    return new Response('unexpected', { status: 404 });
  };
}

test('verifyDevAdmin：无 token / 无效 token → 401；非管理员 / RPC 失败 → 403；管理员放行', async () => {
  const missing = await verifyDevAdmin(ENV, gateRequest());
  assert.equal(!missing.ok && missing.status, 401);

  const invalid = await verifyDevAdmin(ENV, gateRequest('bad'), { fetch: gateMockFetch({ authOk: false }) });
  assert.equal(!invalid.ok && invalid.status, 401);

  const nonAdmin = await verifyDevAdmin(ENV, gateRequest('u-jwt'), { fetch: gateMockFetch({ rpcBody: 'false' }) });
  assert.equal(!nonAdmin.ok && nonAdmin.status, 403);

  const rpcDown = await verifyDevAdmin(ENV, gateRequest('u-jwt'), { fetch: gateMockFetch({ rpcStatus: 500 }) });
  assert.equal(!rpcDown.ok && rpcDown.status, 403);

  let rpcAuth = '';
  const okFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/v1/user')) return json(200, { id: 'u1' });
    if (url.includes('/rest/v1/rpc/is_admin')) {
      rpcAuth = String((init?.headers as Record<string, string>)?.Authorization || '');
      return new Response('true', { status: 200 });
    }
    return new Response('unexpected', { status: 404 });
  };
  const ok = await verifyDevAdmin(ENV, gateRequest('caller-jwt'), { fetch: okFetch });
  assert.equal(ok.ok, true);
  assert.equal(rpcAuth, 'Bearer caller-jwt');
});

// ============================================================
// buildDevMonitorHtml：自包含页面/登录壳/自动刷新/区块齐全
// ============================================================

test('buildDevMonitorHtml：自包含、内嵌 anon key、登录壳、自动刷新与区块齐全', () => {
  const html = buildDevMonitorHtml(ANON_KEY);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('开发监控'));
  assert.ok(html.includes(ANON_KEY));
  assert.ok(html.includes('status?days='));
  assert.ok(!/<script[^>]+src=/i.test(html), '页面不得引用外部脚本');
  assert.ok(!/<link[^>]+href=/i.test(html), '页面不得引用外部样式');
  // 登录壳（与 dashboard-stats 同语义）
  assert.ok(html.includes('id="loginCard"'));
  assert.ok(html.includes('grant_type=password'));
  assert.ok(html.includes('grant_type=refresh_token'));
  assert.ok(html.includes('@yjk.com'));
  assert.ok(html.includes('loadSession();'));
  assert.ok(html.includes('id="logoutBtn"'));
  // 区块
  for (const block of ['服务健康', '任务管线', '成功率', '按模型失败', '失败样本', '卡死任务', 'id="probeGrid"', 'id="failTable"', 'id="stuckTable"']) {
    assert.ok(html.includes(block), `页面缺少区块：${block}`);
  }
  // 自动刷新：默认开启的 30s 轮询，可开关
  assert.ok(html.includes('setInterval'));
  assert.ok(html.includes('autoRefresh'));
  // 敏感信息不进页面
  assert.ok(!html.includes('service-role-key'), '页面不得包含 service_role key');
});

// ============================================================
// aggregateStatus：编排（窗口行/失败样本/花名册/探测并行）
// ============================================================

test('aggregateStatus：编排管线/失败样本/探测并输出完整状态 JSON', async () => {
  const calls: string[] = [];
  const windowRows = [
    { user_id: 'u1', type: 'image', status: 'completed', created_at: '2026-09-15T01:00:00Z', completed_at: '2026-09-15T01:00:20Z', model: 'm-a' },
    { user_id: 'u1', type: 'image', status: 'failed', created_at: '2026-09-15T02:00:00Z', completed_at: '2026-09-15T02:00:10Z', model: 'm-a' },
    { user_id: 'u2', type: 'image', status: 'submitted', created_at: '2020-01-01T00:00:00Z', completed_at: null, model: 'm-b' },
  ];
  const fetchImpl = routeFetch(
    [
      {
        match: (u) => u.includes('/rest/v1/task_submissions') && u.includes('status=eq.failed'),
        respond: () =>
          json(200, [
            {
              user_id: 'u1', type: 'image', status: 'failed',
              created_at: '2026-09-15T02:00:00Z', completed_at: '2026-09-15T02:00:10Z',
              model: 'm-a', error: { message: 'upstream timeout' },
            },
          ]),
      },
      {
        match: (u) => u.includes('/rest/v1/task_submissions?select=id&limit=1'),
        respond: () => json(200, []),
      },
      {
        match: (u) => u.includes('/rest/v1/task_submissions'),
        respond: () => json(200, windowRows),
      },
      {
        match: (u) => u.includes('/rest/v1/user_profiles'),
        respond: () => json(200, [{ user_id: 'u1', department: '方案中心', region: '广州', oa_account: 'alice', created_at: '2026-08-01T00:00:00Z' }]),
      },
      { match: (u) => u.includes('/auth/v1/health'), respond: () => json(200, {}) },
      { match: (u) => u.includes('/storage/v1/status'), respond: () => json(200, {}) },
      { match: (u) => u.includes('/functions/v1/ai-proxy/quota'), respond: () => json(401, {}) },
      { match: (u) => u.includes('/rest/v1/configs?key=eq.NEWAPI_URL'), respond: () => json(200, [{ value: 'http://gw.local' }]) },
      { match: (u) => u.includes('/rest/v1/configs?key=eq.NEWAPI_TOKEN'), respond: () => json(200, [{ value: 'admintok' }]) },
      { match: (u) => u.includes('/api/status'), respond: () => json(200, { success: true }) },
      { match: (u) => u.includes('/api/token/'), respond: () => json(200, { data: { items: [] } }) },
    ],
    calls
  );

  const status = await aggregateStatus(ENV, 7, { fetch: fetchImpl });

  // 探测 6 项全绿
  assert.equal(status.probes.length, 6);
  assert.ok(status.probes.every((p) => p.ok === true), '全部探测应为存活');

  // 管线：1 成功 1 失败 1 卡死 → 成功率 0.5
  assert.equal(status.pipeline.counts.completed, 1);
  assert.equal(status.pipeline.counts.failed, 1);
  assert.equal(status.pipeline.counts.stuck, 1);
  assert.equal(status.pipeline.successRate, 0.5);

  // 失败样本：OA 归属 + 错误摘要
  assert.equal(status.recentFailures.length, 1);
  assert.equal(status.recentFailures[0].oa, 'alice');
  assert.equal(status.recentFailures[0].errorSummary, 'upstream timeout');

  // 卡死列表
  assert.equal(status.stuckList.length, 1);
  assert.equal(status.stuckList[0].type, 'image');

  // 窗口行查询须带 model 提取与时间下界；天数越界收敛
  assert.ok(calls.some((u) => u.includes('model:params-%3E%3Emodel')));
  assert.ok(calls.some((u) => u.includes('created_at=gte.')));
  const status2 = await aggregateStatus(ENV, 999, { fetch: fetchImpl });
  assert.equal(status2.days, 90);
});

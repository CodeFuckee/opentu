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
  auditBucketObjects,
  auditResultIntegrity,
  buildDevMonitorHtml,
  classifyFailureCategory,
  collectResultPrefixes,
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
// 平台错误率：失败分类（余额不足/上游失败/平台）与指标
// ============================================================

test('classifyFailureCategory：余额不足关键词（message 与 apiErrorBody 均可命中）', () => {
  assert.equal(classifyFailureCategory({ message: 'insufficient_user_quota' }), 'balance');
  assert.equal(
    classifyFailureCategory({ message: '请求失败', apiErrorBody: '{"error":{"code":"insufficient_user_quota"}}' }),
    'balance'
  );
  assert.equal(classifyFailureCategory({ message: '预扣费额度失败' }), 'balance');
  assert.equal(classifyFailureCategory('账户余额不足，请充值'), 'balance');
  assert.equal(classifyFailureCategory({ message: '令牌额度已用尽' }), 'balance');
  assert.equal(classifyFailureCategory({ message: 'quota is not enough' }), 'balance');
});

test('classifyFailureCategory：上游失败关键词与 502/503/504 状态码', () => {
  assert.equal(classifyFailureCategory({ message: 'upstream error: provider exploded' }), 'upstream');
  assert.equal(classifyFailureCategory({ apiErrorBody: '<html>502 Bad Gateway</html>' }), 'upstream');
  assert.equal(classifyFailureCategory({ message: '上游超时，请稍后重试' }), 'upstream');
  assert.equal(classifyFailureCategory({ httpStatus: 502, message: 'request failed' }), 'upstream');
  assert.equal(classifyFailureCategory({ httpStatus: 504 }), 'upstream');
  // 余额不足优先于上游（两者同时出现按外部原因处理）
  assert.equal(
    classifyFailureCategory({ message: '上游返回 insufficient_user_quota' }),
    'balance'
  );
});

test('classifyFailureCategory：其余失败归平台（含 edge 被杀、超时、未知、空值）', () => {
  assert.equal(classifyFailureCategory({ message: 'WorkerRequestCancelled: worker was cancelled' }), 'platform');
  assert.equal(classifyFailureCategory({ message: 'Request timeout after 30000ms' }), 'platform');
  assert.equal(classifyFailureCategory({ httpStatus: 500, message: 'internal error' }), 'platform');
  assert.equal(classifyFailureCategory({ message: 'AI 拒绝生成此内容' }), 'platform');
  assert.equal(classifyFailureCategory(null), 'platform');
  assert.equal(classifyFailureCategory(undefined), 'platform');
  assert.equal(classifyFailureCategory({}), 'platform');
});

test('aggregatePipeline：失败分类计数与平台错误率（外部原因整体排除在分子分母之外）', () => {
  const rows = [
    { type: 'image', status: 'completed', created_at: '2026-09-15T01:00:00Z', completed_at: '2026-09-15T01:00:20Z', model: 'm-a' },
    { type: 'image', status: 'completed', created_at: '2026-09-15T02:00:00Z', completed_at: '2026-09-15T02:00:20Z', model: 'm-a' },
    { type: 'image', status: 'completed', created_at: '2026-09-15T03:00:00Z', completed_at: '2026-09-15T03:00:20Z', model: 'm-a' },
    { type: 'chat', status: 'cancelled', created_at: '2026-09-15T04:00:00Z', completed_at: null, model: 'm-a' },
    // 余额不足 → 排除
    { type: 'image', status: 'failed', created_at: '2026-09-15T05:00:00Z', completed_at: '2026-09-15T05:00:10Z', model: 'm-a', error: { message: 'insufficient_user_quota' } },
    // 上游失败 → 排除
    { type: 'image', status: 'failed', created_at: '2026-09-15T06:00:00Z', completed_at: '2026-09-15T06:00:10Z', model: 'm-b', error: { httpStatus: 502 } },
    // 平台错误 → 计入
    { type: 'image', status: 'failed', created_at: '2026-09-15T07:00:00Z', completed_at: '2026-09-15T07:00:10Z', model: 'm-b', error: { message: 'WorkerRequestCancelled' } },
  ] as never;

  const stats = aggregatePipeline(rows);
  assert.deepEqual(stats.failureCategories, { balance: 1, upstream: 1, platform: 1 });
  // 分母 = completed(3) + cancelled(1) + 平台错误(1) = 5 → 1/5 = 0.2
  assert.equal(stats.platformErrorRate, 0.2);
  // 原有总成功率口径不受影响：3/(3+1+3) = 0.4286
  assert.equal(stats.successRate, 0.4286);
});

test('aggregatePipeline：无失败时平台错误率为 0；全外部失败时也为 0；无终态任务为 null', () => {
  const healthy = aggregatePipeline([
    { type: 'image', status: 'completed', created_at: '2026-09-15T01:00:00Z', completed_at: '2026-09-15T01:00:20Z', model: 'm-a' },
  ] as never);
  assert.deepEqual(healthy.failureCategories, { balance: 0, upstream: 0, platform: 0 });
  assert.equal(healthy.platformErrorRate, 0);

  const allExternal = aggregatePipeline([
    { type: 'image', status: 'completed', created_at: '2026-09-15T01:00:00Z', completed_at: '2026-09-15T01:00:20Z', model: 'm-a' },
    { type: 'image', status: 'failed', created_at: '2026-09-15T02:00:00Z', completed_at: '2026-09-15T02:00:10Z', model: 'm-a', error: { message: '余额不足' } },
  ] as never);
  assert.deepEqual(allExternal.failureCategories, { balance: 1, upstream: 0, platform: 0 });
  assert.equal(allExternal.platformErrorRate, 0);

  const noTerminal = aggregatePipeline([
    { type: 'image', status: 'submitted', created_at: new Date(Date.now() - 60_000).toISOString(), completed_at: null, model: 'm-a' },
  ] as never);
  assert.equal(noTerminal.platformErrorRate, null);
});

test('buildDevMonitorHtml：页面包含平台错误率卡片', () => {
  const html = buildDevMonitorHtml(ANON_KEY);
  assert.ok(html.includes('平台错误率'), '页面缺少平台错误率卡片');
  assert.ok(html.includes('已排除'), '平台错误率卡需说明排除口径');
});



// ============================================================
// 结果完整性：成功任务的图片结果是否在 bucket、大小是否为 0
// ============================================================

function integrityRows() {
  return [
    // 干净：路径存在且大小 > 0
    { user_id: 'u1', type: 'image', status: 'completed', created_at: '2026-09-15T01:00:00Z', completed_at: '2026-09-15T01:00:20Z', model: 'm-a', response_file_paths: ['alice/2026-09-15/ok1.png'] },
    // 结果未归档：completed 但 response_file_paths 为空（缺列/空数组等价）
    { user_id: 'u1', type: 'image', status: 'completed', created_at: '2026-09-15T02:00:00Z', completed_at: '2026-09-15T02:00:20Z', model: 'm-a', response_file_paths: [] },
    { user_id: 'u1', type: 'image', status: 'completed', created_at: '2026-09-15T02:30:00Z', completed_at: '2026-09-15T02:40:00Z', model: 'm-a' },
    // 路径在 bucket 找不到（前缀已核验）
    { user_id: 'u2', type: 'image', status: 'completed', created_at: '2026-09-15T03:00:00Z', completed_at: '2026-09-15T03:00:20Z', model: 'm-b', response_file_paths: ['bob/2026-09-15/gone.png'] },
    // 存在但大小为 0
    { user_id: 'u3', type: 'video', status: 'completed', created_at: '2026-09-15T04:00:00Z', completed_at: '2026-09-15T04:05:00Z', model: 'm-c', response_file_paths: ['carol/2026-09-15/empty.mp4'] },
    // chat 无文件产出，不参与统计
    { user_id: 'u1', type: 'chat', status: 'completed', created_at: '2026-09-15T05:00:00Z', completed_at: '2026-09-15T05:00:05Z', model: 'm-d', response_file_paths: [] },
    // 非成功任务不参与统计
    { user_id: 'u1', type: 'image', status: 'failed', created_at: '2026-09-15T06:00:00Z', completed_at: '2026-09-15T06:00:10Z', model: 'm-a', response_file_paths: [] },
    // 前缀未核验（超上限）→ 未核验，不计入缺失
    { user_id: 'u4', type: 'image', status: 'completed', created_at: '2026-09-15T07:00:00Z', completed_at: '2026-09-15T07:00:20Z', model: 'm-e', response_file_paths: ['dave/2026-09-15/x.png'] },
  ];
}

test('auditResultIntegrity：未归档/不在 bucket/零字节分类计数与样本', () => {
  const bucket = {
    sizes: new Map([
      ['alice/2026-09-15/ok1.png', 120],
      ['carol/2026-09-15/empty.mp4', 0],
    ]),
    verifiedPrefixes: new Set(['alice/2026-09-15/', 'bob/2026-09-15/', 'carol/2026-09-15/']),
    listedObjects: 2,
  };
  const oaByUser = new Map([['u1', 'alice'], ['u2', 'bob']]);
  const stats = auditResultIntegrity(integrityRows() as never, bucket, oaByUser);

  // 应产出文件任务：6 个 completed 的 image/video/audio（chat/failed 不算）
  assert.equal(stats.fileTaskTotal, 6);
  assert.equal(stats.notArchived, 2);
  assert.equal(stats.missingFromBucket, 1);
  assert.equal(stats.zeroSize, 1);
  assert.equal(stats.unverified, 1);
  // 样本：缺失与零字节各一条，带 OA 与路径
  const missing = stats.samples.find((s) => s.issue === 'missing');
  assert.equal(missing?.path, 'bob/2026-09-15/gone.png');
  assert.equal(missing?.oa, 'bob');
  const zero = stats.samples.find((s) => s.issue === 'zero');
  assert.equal(zero?.path, 'carol/2026-09-15/empty.mp4');
  assert.equal(zero?.size, 0);
});

test('auditResultIntegrity：干净数据全零，samples 为空', () => {
  const bucket = {
    sizes: new Map([['alice/2026-09-15/ok1.png', 120]]),
    verifiedPrefixes: new Set(['alice/2026-09-15/']),
    listedObjects: 1,
  };
  const stats = auditResultIntegrity(
    [
      { user_id: 'u1', type: 'image', status: 'completed', created_at: '2026-09-15T01:00:00Z', completed_at: '2026-09-15T01:00:20Z', model: 'm', response_file_paths: ['alice/2026-09-15/ok1.png'] },
    ] as never,
    bucket,
    new Map()
  );
  assert.equal(stats.fileTaskTotal, 1);
  assert.equal(stats.notArchived, 0);
  assert.equal(stats.missingFromBucket, 0);
  assert.equal(stats.zeroSize, 0);
  assert.deepEqual(stats.samples, []);
});

test('collectResultPrefixes：取 completed 文件任务的去重前缀（用户名/日期/）', () => {
  const prefixes = collectResultPrefixes(integrityRows() as never);
  assert.deepEqual(
    [...prefixes].sort(),
    ['alice/2026-09-15/', 'bob/2026-09-15/', 'carol/2026-09-15/', 'dave/2026-09-15/']
  );
});

test('auditBucketObjects：前缀并行分页列出，键同时含完整路径与前缀相对名', async () => {
  const calls: string[] = [];
  const fetchImpl = routeFetch(
    [
      {
        // 前缀在请求体里（POST JSON），路由需检查 body
        match: (u, init) =>
          u.includes('/storage/v1/object/list/huabu') && String(init?.body || '').includes('alice'),
        respond: () =>
          json(200, [
            { name: 'ok1.png', metadata: { size: 120 } },
            { name: 'empty.png', metadata: { size: 0 } },
          ]),
      },
      {
        match: (u) => u.includes('/storage/v1/object/list/huabu'),
        respond: (u, init) => {
          calls.push(String(u));
          return json(200, []);
        },
      },
    ],
    calls
  );
  const result = await auditBucketObjects(ENV, ['alice/2026-09-15/', 'bob/2026-09-15/'], { fetch: fetchImpl });
  assert.equal(result.verifiedPrefixes.has('alice/2026-09-15/'), true);
  assert.equal(result.verifiedPrefixes.has('bob/2026-09-15/'), true);
  // 完整路径与前缀相对名都可命中（兼容 storage list 两种返回格式）
  assert.equal(result.sizes.get('alice/2026-09-15/ok1.png'), 120);
  assert.equal(result.sizes.get('ok1.png'), 120);
  assert.equal(result.sizes.get('alice/2026-09-15/empty.png'), 0);
});

test('auditBucketObjects：单前缀列表失败时跳过（不进 verifiedPrefixes），其余照常', async () => {
  const fetchImpl = routeFetch(
    [
      {
        match: (u, init) =>
          u.includes('/storage/v1/object/list/huabu') && String(init?.body || '').includes('alice'),
        respond: () => json(200, [{ name: 'ok1.png', metadata: { size: 5 } }]),
      },
      {
        match: (u, init) =>
          u.includes('/storage/v1/object/list/huabu') && String(init?.body || '').includes('bob'),
        respond: () => json(500, { message: 'boom' }),
      },
    ],
    []
  );
  const result = await auditBucketObjects(ENV, ['alice/2026-09-15/', 'bob/2026-09-15/'], { fetch: fetchImpl });
  assert.equal(result.verifiedPrefixes.has('alice/2026-09-15/'), true);
  assert.equal(result.verifiedPrefixes.has('bob/2026-09-15/'), false);
  assert.equal(result.sizes.get('alice/2026-09-15/ok1.png'), 5);
});

test('buildDevMonitorHtml：页面包含结果完整性区块', () => {
  const html = buildDevMonitorHtml(ANON_KEY);
  for (const block of ['结果完整性', 'id="integrityCards"', '结果未归档', '不在 bucket', '零字节']) {
    assert.ok(html.includes(block), `页面缺少区块：${block}`);
  }
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
    { user_id: 'u1', type: 'image', status: 'completed', created_at: '2026-09-15T01:00:00Z', completed_at: '2026-09-15T01:00:20Z', model: 'm-a', response_file_paths: ['alice/2026-09-15/ok.png'] },
    { user_id: 'u1', type: 'image', status: 'failed', created_at: '2026-09-15T02:00:00Z', completed_at: '2026-09-15T02:00:10Z', model: 'm-a', error: { message: 'insufficient_user_quota' } },
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
              model: 'm-a', error: { message: 'insufficient_user_quota' },
            },
          ]),
      },
      {
        match: (u) => u.includes('/storage/v1/object/list/huabu'),
        respond: () => json(200, [{ name: 'ok.png', metadata: { size: 2048 } }]),
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

  // 管线：1 成功 1 失败（余额不足）1 卡死 → 成功率 0.5；平台错误率 0（外部原因排除）
  assert.equal(status.pipeline.counts.completed, 1);
  assert.equal(status.pipeline.counts.failed, 1);
  assert.equal(status.pipeline.counts.stuck, 1);
  assert.equal(status.pipeline.successRate, 0.5);
  assert.deepEqual(status.pipeline.failureCategories, { balance: 1, upstream: 0, platform: 0 });
  assert.equal(status.pipeline.platformErrorRate, 0);

  // 失败样本：OA 归属 + 错误摘要
  assert.equal(status.recentFailures.length, 1);
  assert.equal(status.recentFailures[0].oa, 'alice');
  assert.equal(status.recentFailures[0].errorSummary, 'insufficient_user_quota');

  // 卡死列表
  assert.equal(status.stuckList.length, 1);
  assert.equal(status.stuckList[0].type, 'image');

  // 结果完整性：1 个成功文件任务，路径在 bucket 且大小 2048 → 全零
  assert.equal(status.resultIntegrity.fileTaskTotal, 1);
  assert.equal(status.resultIntegrity.notArchived, 0);
  assert.equal(status.resultIntegrity.missingFromBucket, 0);
  assert.equal(status.resultIntegrity.zeroSize, 0);

  // 窗口行查询须带 model 提取、error 列、response_file_paths（结果完整性数据源）与时间下界
  assert.ok(calls.some((u) => u.includes('model:params-%3E%3Emodel')));
  assert.ok(calls.some((u) => u.includes('completed_at,error,response_file_paths,model')), '窗口行查询应带出 response_file_paths');
  assert.ok(calls.some((u) => u.includes('/storage/v1/object/list/huabu')), '应对 bucket 前缀做对象核验');
  assert.ok(calls.some((u) => u.includes('created_at=gte.')));
  const status2 = await aggregateStatus(ENV, 999, { fetch: fetchImpl });
  assert.equal(status2.days, 90);
});

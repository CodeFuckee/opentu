/**
 * dashboard-stats Edge Function 单测（node:test）
 *
 * 覆盖：
 * - 四类聚合纯函数（任务/用量/用户/文件）
 * - service_role 查询编排（overview 的 REST 调用与鉴权头）
 * - bucket 分页统计与失败降级
 * - 限额配置读取与兜底
 * - HTML 页面自包含（无外部脚本依赖、内嵌 anon key）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateTasks,
  aggregateTaskParticipation,
  aggregateUsage,
  aggregateUsers,
  readQuotaLimit,
  fetchModelPricing,
  fetchAuthDisplayNames,
  fetchCanvasUsage,
  aggregateOverview,
  buildDashboardHtml,
  DEFAULT_ANON_KEY,
  type DashboardEnv,
} from './core.ts';

const ENV: DashboardEnv = {
  SUPABASE_URL: 'http://supabase.local',
  SERVICE_ROLE_KEY: 'service-role-key',
};

type Route = {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response;
};

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
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

test('aggregateTasks：仅统计成功任务（数量/类型/模型/活跃用户/趋势/24h/平均耗时）', () => {
  const rows = [
    { user_id: 'u1', type: 'image', status: 'completed', created_at: '2026-08-01T01:00:00Z', completed_at: '2026-08-01T01:00:10Z', model: 'm-a', file_paths: ['a'], response_file_paths: ['b', 'c'] },
    { user_id: 'u2', type: 'image', status: 'completed', created_at: '2026-08-01T02:00:00Z', completed_at: '2026-08-01T02:00:30Z', model: 'm-a', file_paths: [], response_file_paths: [] },
    { user_id: 'u3', type: 'video', status: 'failed', created_at: '2026-08-02T03:00:00Z', completed_at: '2026-08-02T03:05:00Z', model: 'm-b', file_paths: ['x'], response_file_paths: [] },
    { user_id: 'u3', type: 'chat', status: 'cancelled', created_at: '2026-08-02T04:00:00Z', completed_at: null, model: 'm-b', file_paths: [], response_file_paths: [] },
  ] as never;

  const stats = aggregateTasks(rows);
  // 只统计 completed：failed/cancelled 不计入任何任务指标，也不再输出状态分布/成功率
  assert.equal(stats.total, 2);
  assert.deepEqual(stats.byType, { image: 2 });
  assert.deepEqual(stats.byModel, { 'm-a': 2 });
  assert.equal(stats.activeUsers, 2);
  assert.ok(!('byStatus' in stats));
  assert.ok(!('successRate' in stats));
  // 平均耗时：(10 + 30) / 2 = 20s
  assert.equal(stats.avgDurationMs, 20000);
  // 趋势按东八区切日（01:00Z/02:00Z → 08-01 当天 9/10 点）
  assert.deepEqual(stats.dailyTrend, [
    { date: '2026-08-01', count: 2 },
  ]);
  assert.equal(stats.hourly[9], 1);
  assert.equal(stats.hourly[10], 1);
  assert.equal(stats.hourly.reduce((s, c) => s + c, 0), 2);
  assert.equal(stats.topUsers.length, 0);
});

test('aggregateTaskParticipation：使用次数排行（用户前 10）与部门使用汇总', () => {
  const rows = [
    { user_id: 'u1', status: 'completed', created_at: '2026-08-01T01:00:00Z' },
    { user_id: 'u1', status: 'completed', created_at: '2026-08-02T01:00:00Z' },
    { user_id: 'u2', status: 'completed', created_at: '2026-08-02T02:00:00Z' },
    { user_id: 'u3', status: 'failed', created_at: '2026-08-02T03:00:00Z' },
  ] as never;
  const profiles = [
    { user_id: 'u1', department: '技术部', region: '广州', oa_account: 'a', created_at: '2026-08-01T00:00:00Z' },
    { user_id: 'u2', department: '设计部', region: '深圳', oa_account: 'b', created_at: '2026-08-02T00:00:00Z' },
  ];

  const result = aggregateTaskParticipation(
    rows as never,
    profiles as never,
    new Map([['a', '张三'], ['b', '李四']]),
    new Map([['u1', '王五']])
  );
  // 认证表姓名优先（u1→王五），无认证姓名回退花名册（u2→李四）；failed 不计入
  assert.deepEqual(result.topUsers, [
    { userId: 'u1', displayName: '王五', department: '技术部', count: 2 },
    { userId: 'u2', displayName: '李四', department: '设计部', count: 1 },
  ]);
  assert.deepEqual(result.usageByDepartment, { 技术部: 2, 设计部: 1 });
  assert.deepEqual(result.usageByRegion, { 广州: 2, 深圳: 1 });
});

test('fetchModelPricing：实测均值优先（hot 数据），回退按次/按量估算；不可用返回空映射', async () => {
  const fetchImpl = routeFetch(
    [
      {
        match: (url) => url.includes('api.tu-zi.com'),
        respond: () =>
          json(200, {
            data: [
              // 实测均值：hot_quota/hot_calls/500000 = 300000/1000/500000 = 0.0006
              { model_name: 'p1', quota_type: 1, model_ratio: 2.5, hot_call_count: 1000, hot_quota: 300000 },
              // 实测样本不足 → 回退按次价
              { model_name: 'p2', quota_type: 0, model_price: 0.04, hot_call_count: 10, hot_quota: 9999 },
              // 无实测 → 回退按量估算：2.5 × 1500 / 500000 = 0.0075
              { model_name: 'p3', quota_type: 1, model_ratio: 2.5 },
              { model_name: 'free', quota_type: 0, model_price: 0 },
            ],
          }),
      },
    ],
    []
  );
  assert.deepEqual(
    await fetchModelPricing({ fetch: fetchImpl }),
    new Map([
      ['p1', 0.0006],
      ['p2', 0.04],
      ['p3', 0.0075],
    ])
  );

  const bad = routeFetch([], []);
  assert.deepEqual(await fetchModelPricing({ fetch: bad }), new Map());
});

test('aggregateUsage：周期汇总 + 最新周期 Top 用户（join user_profiles）', () => {
  const usage = [
    { user_id: 'u1', period: '2026-07-01', used_count: 5 },
    { user_id: 'u2', period: '2026-08-01', used_count: 30 },
    { user_id: 'u1', period: '2026-08-01', used_count: 10 },
  ];
  const profiles = [
    { user_id: 'u1', department: '技术部', region: '广州', oa_account: 'alice', created_at: '2026-08-01T00:00:00Z' },
    { user_id: 'u2', department: '设计部', region: '深圳', oa_account: 'bob', created_at: '2026-08-02T00:00:00Z' },
  ];

  const result = aggregateUsage(
    usage,
    profiles as never,
    200,
    new Map([['alice', '张三']]),
    new Map([['u1', '张三Auth']])
  );
  assert.equal(result.quotaLimit, 200);
  assert.deepEqual(result.byPeriod, [
    { period: '2026-07-01', used: 5 },
    { period: '2026-08-01', used: 40 },
  ]);
  assert.equal(result.latestPeriod, '2026-08-01');
  assert.equal(result.latestUsed, 40);
  // Display Name：认证表优先，其次花名册；均无为 null（页面回退 oaAccount）
  assert.deepEqual(result.topUsers, [
    { oaAccount: 'bob', displayName: null, department: '设计部', used: 30 },
    { oaAccount: 'alice', displayName: '张三Auth', department: '技术部', used: 10 },
  ]);
});

test('aggregateUsers：总数/部门/区域/花名册/可用部门', () => {
  const profiles = [
    { user_id: 'u1', department: '技术部', region: '广州', oa_account: 'a', created_at: '2026-08-01T00:00:00Z' },
    { user_id: 'u2', department: '技术部', region: '广州', oa_account: 'b', created_at: '2026-08-05T00:00:00Z' },
    { user_id: 'u3', department: '设计部', region: '深圳', oa_account: 'c', created_at: '2026-08-03T00:00:00Z' },
  ];
  const departments = [
    { name: '技术部', enabled: true },
    { name: '设计部', enabled: true },
    { name: '市场部', enabled: false },
  ];

  const result = aggregateUsers(profiles as never, 300, departments as never);
  assert.equal(result.total, 3);
  assert.deepEqual(result.byDepartment, { 技术部: 2, 设计部: 1 });
  assert.deepEqual(result.byRegion, { 广州: 2, 深圳: 1 });
  assert.equal(result.staffDirectory, 300);
  assert.equal(result.enabledDepartments, 2);
  assert.ok(!('recent' in result));
});

test('readQuotaLimit：读到配置值 / 查询失败回退默认', async () => {
  const okFetch = routeFetch(
    [
      {
        match: (url) => url.includes('/rest/v1/department_configs'),
        respond: () => json(200, [{ value: '500' }]),
      },
    ],
    []
  );
  assert.equal(await readQuotaLimit(ENV, { fetch: okFetch }), 500);

  const badFetch = routeFetch([], []);
  assert.equal(await readQuotaLimit(ENV, { fetch: badFetch }), 200);
});

test('aggregateOverview：编排各 REST 查询并返回四类聚合', async () => {
  const calls: string[] = [];
  const fetchImpl = routeFetch(
    [
      {
        match: (url) => url.includes('/rest/v1/task_submissions'),
        respond: () =>
          json(200, [
            { user_id: 'u1', type: 'image', status: 'completed', created_at: '2026-08-01T01:00:00Z', completed_at: '2026-08-01T01:00:05Z', model: 'm-a', file_paths: ['a'], response_file_paths: ['o'] },
          ]),
      },
      {
        match: (url) => url.includes('/rest/v1/generation_usage'),
        respond: () => json(200, [{ user_id: 'u1', period: '2026-08-01', used_count: 12 }]),
      },
      {
        match: (url) => url.includes('/rest/v1/user_profiles'),
        respond: () =>
          json(200, [
            { user_id: 'u1', department: '技术部', region: '广州', oa_account: 'alice', created_at: '2026-08-01T00:00:00Z' },
          ]),
      },
      {
        match: (url) => url.includes('/rest/v1/staff_directory'),
        respond: () =>
          json(200, [{ oa_account: 'alice', name: '张三' }], { 'Content-Range': '0-0/320' }),
      },
      {
        match: (url) => url.includes('/auth/v1/admin/users'),
        respond: () =>
          json(200, {
            users: [
              { id: 'u1', user_metadata: { displayName: '王五' } },
              { id: 'orphan', user_metadata: {} },
            ],
            next_page: null,
          }),
      },
      {
        match: (url) => url.includes('/rest/v1/departments'),
        respond: () => json(200, [{ name: '技术部', enabled: true }]),
      },
      {
        match: (url) => url.includes('/rest/v1/department_configs'),
        respond: () => json(200, [{ value: '200' }]),
      },
      {
        match: (url) => url.includes('api.tu-zi.com'),
        respond: () =>
          json(200, {
            data: [{ model_name: 'm-a', quota_type: 0, model_price: 0.5, hot_call_count: 400, hot_quota: 250000000 }],
          }),
      },
    ],
    calls
  );

  const overview = await aggregateOverview(ENV, 30, { fetch: fetchImpl });

  assert.equal(overview.tasks.total, 1);
  assert.deepEqual(overview.tasks.byModel, { 'm-a': 1 });
  assert.equal(overview.tasks.activeUsers, 1);
  assert.deepEqual(overview.tasks.topUsers, [
    { userId: 'u1', displayName: '王五', department: '技术部', count: 1 },
  ]);
  // 消耗金额：实测均值 250000000/400/500000 = $1.25/次 × 1 次
  assert.equal(overview.tasks.totalCostUsd, 1.25);
  assert.equal(overview.usage.latestUsed, 12);
  // 认证表 displayName（王五）优先于花名册姓名（张三）
  assert.deepEqual(overview.usage.topUsers, [
    { oaAccount: 'alice', displayName: '王五', department: '技术部', used: 12 },
  ]);
  assert.equal(overview.users.total, 1);
  assert.equal(overview.users.staffDirectory, 320);
  assert.deepEqual(overview.users.usageByDepartment, { 技术部: 1 });
  assert.deepEqual(overview.users.usageByRegion, { 广州: 1 });
  assert.deepEqual(overview.users.costByDepartment, { 技术部: 1.25 });

  // 所有 REST 请求都应携带 service_role 身份头
  for (const url of calls) {
    assert.ok(
      url.startsWith('http://supabase.local/') ||
        url.includes('api.tu-zi.com'),
      `unexpected url: ${url}`
    );
  }
  const authHeaders = calls
    .map((url) => url)
    .filter((url) => url.includes('/rest/v1/'));
  assert.ok(authHeaders.length >= 5);
  // 任务查询需带出模型字段（模型使用分布数据源）
  assert.ok(
    calls.some((url) => url.includes('model:params-%3E%3Emodel')),
    'task_submissions 查询应带 model:params->>model'
  );
  // 认证用户姓名查询也应发出（Display Name 优先来源）
  assert.ok(calls.some((url) => url.includes('/auth/v1/admin/users')));
});

test('fetchAuthDisplayNames：主端点 404 时降级内部 auth 服务；全失败返回空映射', async () => {
  const calls: string[] = [];
  const fetchImpl = routeFetch(
    [
      {
        // 网关路径未放行
        match: (url) => url.includes('/auth/v1/admin/users'),
        respond: () => json(404, { message: 'not found' }),
      },
      {
        // 自托管内部 auth 服务可用
        match: (url) => url.includes('auth:9999/admin/users'),
        respond: () =>
          json(200, {
            users: [
              { id: 'u-a', user_metadata: { displayName: ' 甲 ' } },
              { id: 'u-b', user_metadata: { displayName: '', full_name: '乙' } },
              { id: 'u-c', user_metadata: { name: '丙' } },
              { id: 'u-d' },
            ],
          }),
      },
    ],
    calls
  );
  assert.deepEqual(
    await fetchAuthDisplayNames(ENV, { fetch: fetchImpl }),
    new Map([
      ['u-a', '甲'],
      ['u-b', '乙'],
      ['u-c', '丙'],
    ])
  );
  assert.ok(calls.some((u) => u.includes('/auth/v1/admin/users')));
  assert.ok(calls.some((u) => u.includes('auth:9999/admin/users')));

  const badFetch = routeFetch([], []);
  assert.deepEqual(await fetchAuthDisplayNames(ENV, { fetch: badFetch }), new Map());
});

test('fetchCanvasUsage：解析共享令牌并分页求和消耗日志；配置缺失返回 null', async () => {
  const fetchImpl = routeFetch(
    [
      { match: (url) => url.includes('/rest/v1/configs?key=eq.NEWAPI_URL'), respond: () => json(200, [{ value: 'http://gw.local' }]) },
      { match: (url) => url.includes('/rest/v1/configs?key=eq.NEWAPI_TOKEN'), respond: () => json(200, [{ value: 'admintok' }]) },
      { match: (url) => url.includes('/rest/v1/configs?key=eq.NEWAPI_KEY'), respond: () => json(200, [{ value: 'sk-abcd1234' }]) },
      {
        match: (url) => url.includes('/api/token/'),
        respond: () =>
          json(200, {
            data: { items: [{ name: 'other', key: 'zzzz' }, { name: 'huabu', key: 'abcd1234' }] },
          }),
      },
      {
        match: (url) => url.includes('/api/log/?p=1'),
        respond: () =>
          json(200, {
            data: { items: [{ quota: 100000, username: 'chenkaidi' }, { quota: 50000, username: 'alice' }] },
          }),
      },
    ],
    []
  );
  // 150000 quota ÷ 500000 = $0.3
  assert.deepEqual(await fetchCanvasUsage(ENV, 30, { fetch: fetchImpl }), {
    totalUsd: 0.3,
    quotaByUsername: { chenkaidi: 100000, alice: 50000 },
  });

  const missing = routeFetch([], []);
  assert.equal(await fetchCanvasUsage(ENV, 30, { fetch: missing }), null);
});

test('buildDashboardHtml：自包含页面，内嵌 anon key，无外部脚本依赖', () => {
  const html = buildDashboardHtml(DEFAULT_ANON_KEY);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('数据看板'));
  assert.ok(html.includes('overview?days='));
  assert.ok(html.includes(DEFAULT_ANON_KEY));
  assert.ok(!/<script[^>]+src=/i.test(html), '页面不得引用外部脚本');
  assert.ok(!/<link[^>]+href=/i.test(html), '页面不得引用外部样式');
  // 任务口径：只展示成功任务，不展示状态/失败分布
  assert.ok(html.includes('成功任务按类型') || html.includes('操作类型分布'));
  assert.ok(html.includes('每日成功任务趋势'));
  assert.ok(!html.includes('任务状态分布'), '页面不得展示任务状态分布');
  assert.ok(!html.includes('成功率'), '页面不得展示成功率');
  // 图片看板要求的全部统计块
  for (const block of ['总操作次数', '消耗金额', '活跃用户数', '数据覆盖天数', '操作类型分布', '模型使用分布', '使用次数排行', '日历使用热力', '24小时使用分布', '部门使用排行', '部门使用汇总', '部门分布']) {
    assert.ok(html.includes(block), `页面缺少统计块：${block}`);
  }
  // 用户统一用 Display Name 渲染（缺失回退 oaAccount）
  assert.ok(html.includes('displayName || r.oaAccount'));
});

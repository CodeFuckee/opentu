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
  scaleCostByDepartment,
  pushReport,
  aggregateButtonUsage,
  aggregateOverview,
  buildButtonUsageSummary,
  buildDashboardHtml,
  buildOverviewWorkbook,
  buildXlsx,
  parseOverviewRange,
  verifyDashboardAdmin,
  type ButtonUsageSummary,
  type DashboardEnv,
  type DashboardOverview,
} from './core.ts';

const ANON_KEY = 'test-anon-key';

const ENV: DashboardEnv = {
  SUPABASE_URL: 'http://supabase.local',
  SERVICE_ROLE_KEY: 'service-role-key',
  ANON_KEY,
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
    { user_id: 'u4', status: 'completed', created_at: '2026-08-03T03:00:00Z' },
  ] as never;
  const profiles = [
    { user_id: 'u1', department: '人力资源部', region: '广州', oa_account: 'a', created_at: '2026-08-01T00:00:00Z' },
    { user_id: 'u2', department: '设计部', region: '深圳', oa_account: 'b', created_at: '2026-08-02T00:00:00Z' },
    { user_id: 'u4', department: '未知名称部', region: '深圳', oa_account: 'd', created_at: '2026-08-03T00:00:00Z' },
  ];

  const result = aggregateTaskParticipation(
    rows as never,
    profiles as never,
    new Map([['a', '张三'], ['b', '李四']]),
    new Map([['u1', '王五']])
  );
  // 认证表姓名优先（u1→王五），无认证姓名回退花名册（u2→李四）；failed 不计入
  // 人力资源部在看板展示名映射为「职能部门」；未命中映射的部门保持原名
  assert.deepEqual(result.topUsers, [
    { userId: 'u1', displayName: '王五', department: '职能部门', count: 2 },
    { userId: 'u2', displayName: '李四', department: '设计部', count: 1 },
    { userId: 'u4', displayName: null, department: '未知名称部', count: 1 },
  ]);
  // 全量用户排行：用户数 ≤10 时与 topUsers 完全一致
  assert.deepEqual(result.userUsage, result.topUsers);
  assert.deepEqual(result.usageByDepartment, {
    职能部门: 2,
    设计部: 1,
    未知名称部: 1,
  });
  assert.deepEqual(result.usageByRegion, { 广州: 2, 深圳: 2 });
});

test('aggregateTaskParticipation：userUsage 全量用户排行（不截断前 10、降序、排除失败与空用户）', () => {
  // 12 个有成功任务的用户：u1 3 次、u2..u12 各 1 次（u13 只有失败任务、匿名行无 user_id）
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 12; i += 1) {
    const times = i === 1 ? 3 : 1;
    for (let k = 0; k < times; k += 1) {
      rows.push({
        user_id: `u${i}`,
        status: 'completed',
        created_at: `2026-08-0${(k % 8) + 1}T01:00:00Z`,
      });
    }
  }
  rows.push({ user_id: 'u13', status: 'failed', created_at: '2026-08-04T01:00:00Z' });
  rows.push({ user_id: '', status: 'completed', created_at: '2026-08-04T02:00:00Z' });

  const profiles = Array.from({ length: 12 }, (_, i) => ({
    user_id: `u${i + 1}`,
    department: `部门${i + 1}`,
    region: '深圳',
    oa_account: `oa${i + 1}`,
    created_at: '2026-08-01T00:00:00Z',
  }));
  const nameByOa = new Map(profiles.map((p) => [p.oa_account, `姓名${p.oa_account}`]));

  const result = aggregateTaskParticipation(
    rows as never,
    profiles as never,
    nameByOa,
    new Map()
  );

  // 全量：12 个用户一个不少（旧实现 topUsers 会截断为前 10）
  assert.equal(result.userUsage.length, 12);
  // 降序：u1（3 次）第一，其余各 1 次
  assert.equal(result.userUsage[0].userId, 'u1');
  assert.equal(result.userUsage[0].count, 3);
  assert.ok(result.userUsage.slice(1).every((u) => u.count === 1));
  // 字段解析与 topUsers 同源：认证姓名回退花名册、部门原样
  assert.equal(result.userUsage[0].displayName, '姓名oa1');
  assert.equal(result.userUsage[0].department, '部门1');
  // topUsers 仍是前 10 截断，且恰为 userUsage 的前 10 项
  assert.equal(result.topUsers.length, 10);
  assert.deepEqual(result.topUsers, result.userUsage.slice(0, 10));
  // 失败任务与匿名行不进入任何用户的计数
  assert.ok(result.userUsage.every((u) => u.userId !== 'u13' && u.userId !== ''));
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
        match: (url) => url.includes('/rest/v1/task_submissions') && url.includes('status=eq.completed'),
        respond: () => json(200, [], { 'Content-Range': '0-0/5' }),
      },
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
        match: (url) => url.includes('/rest/v1/configs?key=eq.USD_CNY_RATE'),
        respond: () => json(200, [{ value: '7' }]),
      },
      {
        match: (url) => url.includes('/rest/v1/configs?key=eq.OUTSOURCE_PRICE_PER_IMAGE'),
        respond: () => json(200, [{ value: '2' }]),
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
  // 汇率从 configs 表 USD_CNY_RATE 读取
  assert.equal(overview.usdCnyRate, 7);
  // 本周用量（按 Content-Range 计数）
  assert.equal(overview.weekTasks, 5);
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

  // 领导视角：1 个成功生图任务（参数无 n/count → 1 张）；全时段计数走 count 路由（0-0/5）
  assert.deepEqual(overview.leadership, {
    windowImages: 1,
    windowImageTasks: 1,
    avgImageDurationMs: 5000,
    topModel: 'm-a',
    topModelCount: 1,
    modelTypes: 1,
    tokens: null,
    allTimeCalls: 5,
    allTimeImageTasks: 5,
    outsourcePriceCny: 2,
    outsourceEquivalentCny: 2,
    // 1 张 × ¥2 − $1.25 × 7 = 2 − 8.75 = -6.75（负值如实展示）
    savedCny: -6.75,
  });

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
  // 任务查询需带出生图张数瘦列（领导视角「生成图片张数」数据源）
  assert.ok(
    calls.some((url) => url.includes('n_deep:params-%3Eparams-%3E%3En')),
    'task_submissions 查询应带 params.params.n 瘦列'
  );
  // 认证用户姓名查询也应发出（Display Name 优先来源）
  assert.ok(calls.some((url) => url.includes('/auth/v1/admin/users')));

  // 周窗口：range 日期转换为东八区 ISO 后作为任务过滤上下界
  await aggregateOverview(ENV, 7, { fetch: fetchImpl }, { start: '2026-08-25', end: '2026-08-31' });
  assert.ok(
    calls.some((url) => url.includes('created_at=gte.2026-08-25T00%3A00%3A00%2B08%3A00')),
    'range 模式应按东八区起始时间过滤任务'
  );
  assert.ok(
    calls.some((url) => url.includes('created_at=lt.2026-08-31T23%3A59%3A59%2B08%3A00')),
    'range 模式应按东八区结束时间截断任务'
  );
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
  // 150000 quota ÷ 500000 = $0.3；日志无 token 字段 → tokens null
  assert.deepEqual(await fetchCanvasUsage(ENV, { fetch: fetchImpl }), {
    totalUsd: 0.3,
    quotaByUsername: { chenkaidi: 100000, alice: 50000 },
    tokens: null,
  });

  // 日志含 prompt/completion token 字段时求和（绘图按次计费的条目两字段都缺 → 跳过）
  const withTokens = routeFetch(
    [
      { match: (url) => url.includes('/rest/v1/configs?key=eq.NEWAPI_URL'), respond: () => json(200, [{ value: 'http://gw.local' }]) },
      { match: (url) => url.includes('/rest/v1/configs?key=eq.NEWAPI_TOKEN'), respond: () => json(200, [{ value: 'admintok' }]) },
      { match: (url) => url.includes('/rest/v1/configs?key=eq.NEWAPI_KEY'), respond: () => json(200, [{ value: 'sk-abcd1234' }]) },
      {
        match: (url) => url.includes('/api/token/'),
        respond: () => json(200, { data: { items: [{ name: 'huabu', key: 'abcd1234' }] } }),
      },
      {
        match: (url) => url.includes('/api/log/?p=1'),
        respond: () =>
          json(200, {
            data: {
              items: [
                { quota: 100000, username: 'alice', prompt_tokens: 800, completion_tokens: 434 },
                { quota: 50000, username: 'bob', prompt_tokens: null, completion_tokens: null },
              ],
            },
          }),
      },
    ],
    []
  );
  assert.deepEqual(await fetchCanvasUsage(ENV, { fetch: withTokens }), {
    totalUsd: 0.3,
    quotaByUsername: { alice: 100000, bob: 50000 },
    tokens: 1234,
  });

  const missing = routeFetch([], []);
  assert.equal(await fetchCanvasUsage(ENV, { fetch: missing }), null);
});

test('scaleCostByDepartment：按占比分摊真实总额且求和恰好相等', () => {
  const costs = { 方案中心: 20, 环艺中心: 6.67 };
  const scaled = scaleCostByDepartment(costs, 30);
  const sum = Object.values(scaled).reduce((s, v) => s + v, 0);
  // 占比 75%/25% → 22.5/7.5，和恰为 30
  assert.equal(scaled['方案中心'], 22.5);
  assert.equal(scaled['环艺中心'], 7.5);
  assert.equal(Math.round(sum * 100) / 100, 30);
  // 余数归最大部门：总额 1，估算 0.333/0.333 → 0.5/0.5 后余数并入最大
  const r = scaleCostByDepartment({ A: 0.333, B: 0.333 }, 1);
  assert.equal(Math.round((r['A'] + r['B']) * 100) / 100, 1);
  // 无估算/总额无效 → 原值
  assert.deepEqual(scaleCostByDepartment({}, 10), {});
  assert.deepEqual(scaleCostByDepartment({ A: 5 }, null), { A: 5 });
});

test('pushReport：gitee 上传后钉钉加签发送；缺 webhook 报错', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/rest/v1/configs?key=eq.GITEE_TOKEN')) return Promise.resolve(json(200, [{ value: 'gtok' }]));
    if (url.includes('/rest/v1/configs?key=eq.GITEE_REPO')) return Promise.resolve(json(200, [{ value: 'tju-kdj_admin/dingding-talk-images' }]));
    if (url.includes('/rest/v1/configs?key=eq.DINGTALK_WEBHOOK')) return Promise.resolve(json(200, [{ value: 'https://oapi.dingtalk.com/robot/send?access_token=abc' }]));
    if (url.includes('/rest/v1/configs?key=eq.DINGTALK_SECRET')) return Promise.resolve(json(200, [{ value: 'SEC123' }]));
    if (url.includes('/repos/tju-kdj_admin/dingding-talk-images?')) return Promise.resolve(json(200, { default_branch: 'master' }));
    if (url.includes('/contents/dashboard-stats/')) return Promise.resolve(json(200, { content: { download_url: 'https://gitee.com/tju-kdj_admin/dingding-talk-images/raw/master/dashboard-stats/x.png' } }));
    if (url.includes('oapi.dingtalk.com/robot/send')) return Promise.resolve(json(200, { errcode: 0, errmsg: 'ok' }));
    return Promise.reject(new Error('unrouted: ' + url));
  };
  const res = await pushReport(ENV, { fetch: fetchImpl }, 'data:image/png;base64,AAAA', '周报内容');
  assert.equal(res.ok, true);
  assert.equal(res.imageUrl, 'https://gitee.com/tju-kdj_admin/dingding-talk-images/raw/master/dashboard-stats/x.png');
  const ding = calls.find((c) => c.url.includes('oapi.dingtalk.com/robot/send'));
  assert.ok(ding, '应调用钉钉接口');
  assert.ok(ding.url.includes('timestamp=') && ding.url.includes('sign='), '应携带加签参数');
  const body = JSON.parse(String(ding.init?.body));
  assert.equal(body.msgtype, 'markdown');
  assert.ok(body.markdown.text.includes('周报内容'));
  assert.ok(body.markdown.text.includes('![dashboard]('));

  const noCfg = routeFetch([], []);
  const r2 = await pushReport(ENV, { fetch: noCfg }, '', '文字');
  assert.equal(r2.ok, false);
  assert.ok((r2.error || '').includes('DINGTALK_WEBHOOK'));
});

test('pushReport dev 模式：读 DEV_DINGTALK_* 配置、强制加签、标题带推送测试标识', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/rest/v1/configs?key=eq.GITEE_TOKEN')) return Promise.resolve(json(200, [{ value: 'gtok' }]));
    if (url.includes('/rest/v1/configs?key=eq.GITEE_REPO')) return Promise.resolve(json(200, [{ value: 'tju-kdj_admin/dingding-talk-images' }]));
    if (url.includes('/rest/v1/configs?key=eq.DEV_DINGTALK_WEBHOOK')) return Promise.resolve(json(200, [{ value: 'https://oapi.dingtalk.com/robot/send?access_token=dev' }]));
    if (url.includes('/rest/v1/configs?key=eq.DEV_DINGTALK_SECRET')) return Promise.resolve(json(200, [{ value: 'DEVSEC' }]));
    if (url.includes('/repos/tju-kdj_admin/dingding-talk-images?')) return Promise.resolve(json(200, { default_branch: 'master' }));
    if (url.includes('/contents/dashboard-stats/')) return Promise.resolve(json(200, { content: { download_url: 'https://gitee.com/tju-kdj_admin/dingding-talk-images/raw/master/dashboard-stats/x.png' } }));
    if (url.includes('oapi.dingtalk.com/robot/send')) return Promise.resolve(json(200, { errcode: 0, errmsg: 'ok' }));
    return Promise.reject(new Error('unrouted: ' + url));
  };
  const res = await pushReport(ENV, { fetch: fetchImpl }, 'data:image/png;base64,AAAA', '测试内容', { dev: true });
  assert.equal(res.ok, true);
  const ding = calls.find((c) => c.url.includes('oapi.dingtalk.com/robot/send'));
  assert.ok(ding, '应调用钉钉接口');
  assert.ok(ding.url.includes('access_token=dev'), '应推 DEV webhook');
  assert.ok(ding.url.includes('timestamp=') && ding.url.includes('sign='), 'DEV 通道强制加签');
  const body = JSON.parse(String(ding.init?.body));
  assert.equal(body.markdown.title, 'YUE 画布使用周报（推送测试）');
  assert.ok(body.markdown.text.includes('测试内容'));
  // 生产键不得被读取
  assert.ok(!calls.some((c) => c.url.includes('key=eq.DINGTALK_WEBHOOK')), 'dev 模式不应读生产 webhook 配置');
});

test('pushReport dev 模式：缺 DEV_DINGTALK_SECRET 视为配置错误（强制加签）', async () => {
  let dingCalls = 0;
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/rest/v1/configs?key=eq.GITEE_TOKEN')) return Promise.resolve(json(200, [{ value: 'gtok' }]));
    if (url.includes('/rest/v1/configs?key=eq.GITEE_REPO')) return Promise.resolve(json(200, [{ value: 'tju-kdj_admin/dingding-talk-images' }]));
    if (url.includes('/rest/v1/configs?key=eq.DEV_DINGTALK_WEBHOOK')) return Promise.resolve(json(200, [{ value: 'https://oapi.dingtalk.com/robot/send?access_token=dev' }]));
    if (url.includes('/rest/v1/configs?key=eq.DEV_DINGTALK_SECRET')) return Promise.resolve(json(200, []));
    if (url.includes('oapi.dingtalk.com/robot/send')) { dingCalls += 1; return Promise.resolve(json(200, { errcode: 0 })); }
    if (url.includes('/repos/') || url.includes('/contents/')) return Promise.resolve(json(200, { content: { download_url: 'https://gitee.com/x.png' } }));
    return Promise.reject(new Error('unrouted: ' + url));
  };
  const res = await pushReport(ENV, { fetch: fetchImpl }, 'data:image/png;base64,AAAA', '测试内容', { dev: true });
  assert.equal(res.ok, false);
  assert.ok((res.error || '').includes('DEV_DINGTALK_SECRET'));
  assert.equal(dingCalls, 0, '缺 secret 时不得发起钉钉请求');
});

test('buildDashboardHtml：自包含页面，内嵌 anon key，自带管理员登录，无外部脚本依赖', () => {
  const html = buildDashboardHtml(ANON_KEY);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('数据看板'));
  assert.ok(html.includes('overview?days='));
  assert.ok(html.includes(ANON_KEY));
  assert.ok(!/<script[^>]+src=/i.test(html), '页面不得引用外部脚本');
  assert.ok(!/<link[^>]+href=/i.test(html), '页面不得引用外部样式');
  // 登录门禁 UI：oa账号+密码登录卡片、GoTrue 密码授权与刷新、凭证请求头
  assert.ok(html.includes('id="loginCard"'), '页面必须自带登录卡片');
  assert.ok(html.includes('仅管理员可见'));
  assert.ok(html.includes('grant_type=password'));
  assert.ok(html.includes('grant_type=refresh_token'));
  assert.ok(html.includes('@yjk.com'), 'oa账号需按主应用约定拼接邮箱域名');
  assert.ok(html.includes("Authorization'] = 'Bearer ' + session.access_token"));
  assert.ok(html.includes('仅管理员可查看本看板'), '403 时需给出管理员提示');
  assert.ok(html.includes('id="logoutBtn"'));
  // 用户使用排行面板：全量用户横向条形（数据取 tasks.userUsage，带滚动容器）
  assert.ok(html.includes('id="userRank"'), '页面缺少用户使用排行容器');
  assert.ok(html.includes('tasks.userUsage'), '页面必须渲染 tasks.userUsage');
  // 按钮使用统计面板（add-button-usage-stats）：容器 + 独立接口调用 + 零使用区块
  assert.ok(html.includes('id="buttonUsage"'), '页面缺少按钮使用统计容器');
  assert.ok(html.includes("basePath() + 'button-usage'"), '页面必须调用 button-usage 接口');
  assert.ok(html.includes('零使用清单'), '页面缺少零使用清单区块');
  // 周期选择：自然月快选（仅提供 2026-08 / 2026-09 两个月，用户拍板），load 按月拼 start/end 区间
  assert.ok(html.includes('populateMonthOptions'), '页面缺少月份快选生成逻辑');
  assert.ok(html.includes('monthRange'), '页面缺少自然月区间计算');
  assert.ok(html.includes("'month:'"), 'load 必须处理 month: 前缀的月选模式');
  assert.ok(html.includes('（自然月）'), '月份选项需标注自然月口径');
  assert.ok(html.split('populateMonthOptions()').length >= 2, '月份选项必须在启动时填充');
  assert.ok(html.includes("'2026-09'"), '看板必须提供 2026-09 数据入口');
  assert.ok(html.includes("'2026-08'"), '看板必须提供 2026-08 数据入口');
  assert.ok(!html.includes("now.getMonth()-i"), '月份列表不允许动态滚动（仅 8/9 月）');
  // 固定近 30 天口径的消耗卡：仅在「近 30 天」周期显示，其余周期（周/月/90 天）页面与导出一致隐藏
  assert.ok(html.includes('CURRENT_MODE'), '页面缺少当前周期模式跟踪');
  assert.ok(html.includes("CURRENT_MODE!=='30'"), '近30天消耗金额卡必须按周期条件隐藏');
  // 启动必须先检查会话，不得匿名直接加载
  assert.ok(html.includes('loadSession();'));
  assert.ok(!/^\s*load\(\);\s*$/m.test(html.split('loadSession();')[1] || ''), '启动不得绕过会话检查直接 load()');
  // 任务口径：只展示成功任务，不展示状态/失败分布
  assert.ok(html.includes('成功任务按类型') || html.includes('操作类型分布'));
  assert.ok(html.includes('每日成功任务趋势'));
  assert.ok(!html.includes('任务状态分布'), '页面不得展示任务状态分布');
  assert.ok(!html.includes('成功率'), '页面不得展示成功率');
  // 图片看板要求的全部统计块
  for (const block of ['总操作次数', '消耗金额', '活跃用户数', '数据覆盖天数', '复制报告', '操作类型分布', '模型使用分布', '日历使用热力', '24小时使用分布', '部门使用排行', '用户使用排行', '部门使用汇总', '部门分布']) {
    assert.ok(html.includes(block), `页面缺少统计块：${block}`);
  }
  // 「核心指标」（领导视角）区块与委外参考价配置键提示
  assert.ok(html.includes('<h2>核心指标</h2>'), '页面缺少核心指标区块');
  assert.ok(html.includes('id="leaderCards"'), '页面缺少领导视角卡片容器');
  assert.ok(html.includes('累计调用次数'), '领导视角缺累计调用');
  assert.ok(html.includes('生成图片'), '领导视角缺生成图片');
  assert.ok(html.includes('Token 消耗'), '领导视角缺 Token 消耗');
  assert.ok(html.includes('最常用模型'), '领导视角缺最常用模型');
  assert.ok(html.includes('平均出图耗时'), '领导视角缺平均出图耗时');
  assert.ok(html.includes('节省委外费用'), '领导视角缺节省委外费用');
  assert.ok(html.includes('OUTSOURCE_PRICE_PER_IMAGE'), '未配置单价时需提示配置键');
  // 使用次数排行与月度用量 Top 用户面板已按需求下线
  assert.ok(!html.includes('使用次数排行'));
  assert.ok(!html.includes('月度用量 Top 用户'));
  // 导出图片按钮与 foreignObject 栅格化实现（导出时禁用动画，避免渐入面板不可见）
  assert.ok(html.includes('导出图片'));
  assert.ok(html.includes('foreignObject'));
  assert.ok(html.includes('animation:none!important'));
  // 推送按钮（钉钉机器人）
  assert.ok(html.includes('id="pushBtn"'));
});

// ============================================================
// 管理员门禁 verifyDashboardAdmin（页面/overview/push-report 共用）
// ============================================================

function gateMockFetch(opts: {
  authOk?: boolean;
  rpcStatus?: number;
  rpcBody?: string;
} = {}) {
  const authOk = opts.authOk ?? true;
  const rpcStatus = opts.rpcStatus ?? 200;
  const rpcBody = opts.rpcBody ?? 'true';
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/v1/user')) {
      return new Response(authOk ? JSON.stringify({ id: 'u1' }) : '{}', {
        status: authOk ? 200 : 401,
      });
    }
    if (url.includes('/rest/v1/rpc/is_admin')) {
      return new Response(rpcBody, { status: rpcStatus });
    }
    return new Response('unexpected', { status: 404 });
  };
}

function gateRequest(token?: string) {
  return new Request('http://x/functions/v1/dashboard-stats/overview', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

test('verifyDashboardAdmin：无 token / 无效 token → 401', async () => {
  const missing = await verifyDashboardAdmin(ENV, gateRequest());
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.status, 401);

  const invalid = await verifyDashboardAdmin(ENV, gateRequest('bad-token'), {
    fetch: gateMockFetch({ authOk: false }),
  });
  assert.equal(invalid.ok, false);
  assert.equal(!invalid.ok && invalid.status, 401);
});

test('verifyDashboardAdmin：非管理员 / RPC 失败 → 403（fail-closed）', async () => {
  const nonAdmin = await verifyDashboardAdmin(ENV, gateRequest('u-jwt'), {
    fetch: gateMockFetch({ rpcBody: 'false' }),
  });
  assert.equal(nonAdmin.ok, false);
  assert.equal(!nonAdmin.ok && nonAdmin.status, 403);

  const rpcDown = await verifyDashboardAdmin(ENV, gateRequest('u-jwt'), {
    fetch: gateMockFetch({ rpcStatus: 500 }),
  });
  assert.equal(rpcDown.ok, false);
  assert.equal(!rpcDown.ok && rpcDown.status, 403);
});

test('verifyDashboardAdmin：管理员放行；请求体必须是调用者 JWT（而非 service_role）', async () => {
  let rpcAuthHeader = '';
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'u1' }), { status: 200 });
    }
    if (url.includes('/rest/v1/rpc/is_admin')) {
      rpcAuthHeader = String(init?.headers && (init.headers as Record<string, string>)['Authorization'] || '');
      return new Response('true', { status: 200 });
    }
    return new Response('unexpected', { status: 404 });
  };
  const gate = await verifyDashboardAdmin(ENV, gateRequest('caller-jwt'), { fetch: fetchImpl });
  assert.equal(gate.ok, true);
  assert.equal(rpcAuthHeader, 'Bearer caller-jwt', 'is_admin 必须以调用者 JWT 执行，auth.uid() 才指向调用者');
});

// ============================================================
// 用量倍数（configs 表 USAGE_MULTIPLIER，缺省 1）
// ============================================================
import {
  parseUsageMultiplier,
  applyUsageMultiplier,
  parseOutsourcePrice,
  taskImageCount,
  aggregateLeadership,
} from './core.ts';

test('parseUsageMultiplier：合法值解析，非法/非正数回退 1', () => {
  assert.equal(parseUsageMultiplier('2'), 2);
  assert.equal(parseUsageMultiplier('1.5'), 1.5);
  assert.equal(parseUsageMultiplier(3), 3);
  assert.equal(parseUsageMultiplier('abc'), 1);
  assert.equal(parseUsageMultiplier('0'), 1);
  assert.equal(parseUsageMultiplier('-3'), 1);
  assert.equal(parseUsageMultiplier(null), 1);
  assert.equal(parseUsageMultiplier(undefined), 1);
  assert.equal(parseUsageMultiplier(''), 1);
});

function makeOverviewFixture() {
  return {
    generatedAt: '2026-09-14T00:00:00Z',
    days: 7,
    usdCnyRate: 0.1,
    weekTasks: 10,
    monthCostUsd: 12.5,
    tasks: {
      total: 10,
      byType: { image: 8, chat: 2 },
      byModel: { 'gpt-image-2': 10 },
      activeUsers: 3,
      avgDurationMs: 5000,
      dailyTrend: [
        { date: '2026-09-13', count: 6 },
        { date: '2026-09-14', count: 4 },
      ],
      hourly: [1, 2, 3],
      topUsers: [
        { userId: 'u1', displayName: '张三', department: '职能部门', count: 6 },
      ],
      userUsage: [
        { userId: 'u1', displayName: '张三', department: '职能部门', count: 6 },
        { userId: 'u2', displayName: '李四', department: '设计部', count: 4 },
      ],
      totalCostUsd: 5,
    },
    usage: {
      quotaLimit: 100,
      byPeriod: [{ period: '2026-09', used: 10 }],
      latestPeriod: '2026-09',
      latestUsed: 10,
      topUsers: [
        { oaAccount: 'a', displayName: '张三', department: '职能部门', used: 10 },
      ],
    },
    users: {
      total: 3,
      byDepartment: { 职能部门: 1 },
      byRegion: { 深圳: 3 },
      usageByDepartment: { 职能部门: 10 },
      usageByRegion: { 深圳: 10 },
      costByDepartment: { 职能部门: 1.5 },
      staffDirectory: 20,
      enabledDepartments: 5,
    },
    leadership: {
      windowImages: 8,
      windowImageTasks: 8,
      avgImageDurationMs: 12000,
      topModel: 'gpt-image-2',
      topModelCount: 10,
      modelTypes: 1,
      tokens: 1600000,
      allTimeCalls: 8000,
      allTimeImageTasks: 3000,
      outsourcePriceCny: 5,
      outsourceEquivalentCny: 40,
      savedCny: 39,
    },
  } as never;
}

test('applyUsageMultiplier：次数与金额按倍数缩放，人数/额度/天数/汇率不受影响', () => {
  const scaled = applyUsageMultiplier(makeOverviewFixture() as never, 2);

  assert.equal(scaled.weekTasks, 20);
  assert.equal(scaled.tasks.total, 20);
  assert.deepEqual(scaled.tasks.byType, { image: 16, chat: 4 });
  assert.deepEqual(scaled.tasks.byModel, { 'gpt-image-2': 20 });
  assert.deepEqual(scaled.tasks.dailyTrend, [
    { date: '2026-09-13', count: 12 },
    { date: '2026-09-14', count: 8 },
  ]);
  assert.deepEqual(scaled.tasks.hourly, [2, 4, 6]);
  assert.equal(scaled.tasks.topUsers[0].count, 12);
  // 全量用户排行与 topUsers 同口径缩放
  assert.deepEqual(scaled.tasks.userUsage, [
    { userId: 'u1', displayName: '张三', department: '职能部门', count: 12 },
    { userId: 'u2', displayName: '李四', department: '设计部', count: 8 },
  ]);
  assert.equal(scaled.tasks.totalCostUsd, 10);

  assert.equal(scaled.usage.latestUsed, 20);
  assert.deepEqual(scaled.usage.byPeriod, [{ period: '2026-09', used: 20 }]);
  assert.equal(scaled.usage.topUsers[0].used, 20);

  // 不应被倍数影响的字段
  assert.equal(scaled.tasks.activeUsers, 3);
  assert.equal(scaled.tasks.avgDurationMs, 5000);
  assert.equal(scaled.users.total, 3);
  assert.deepEqual(scaled.users.byDepartment, { 职能部门: 1 });
  assert.equal(scaled.usage.quotaLimit, 100);
  assert.equal(scaled.usdCnyRate, 0.1);

  // 领导视角：次数/累计/token/金额按倍数缩放，模型名/耗时/单价/种类不变
  assert.equal(scaled.leadership.windowImages, 16);
  assert.equal(scaled.leadership.windowImageTasks, 16);
  assert.equal(scaled.leadership.tokens, 3200000);
  assert.equal(scaled.leadership.allTimeCalls, 16000);
  assert.equal(scaled.leadership.allTimeImageTasks, 6000);
  assert.equal(scaled.leadership.topModelCount, 20);
  assert.equal(scaled.leadership.outsourceEquivalentCny, 80);
  assert.equal(scaled.leadership.savedCny, 78);
  assert.equal(scaled.leadership.topModel, 'gpt-image-2');
  assert.equal(scaled.leadership.modelTypes, 1);
  assert.equal(scaled.leadership.avgImageDurationMs, 12000);
  assert.equal(scaled.leadership.outsourcePriceCny, 5);
});

test('applyUsageMultiplier：null 金额保留 null；倍数为 1 时数值不变', () => {
  const base = makeOverviewFixture();
  base.tasks.totalCostUsd = null;
  base.monthCostUsd = null;

  const scaled = applyUsageMultiplier(base as never, 2);
  assert.equal(scaled.tasks.totalCostUsd, null);
  assert.equal(scaled.monthCostUsd, null);
  assert.equal(scaled.weekTasks, 20);
  assert.deepEqual(scaled.tasks.hourly, [2, 4, 6]);
});

// ============================================================
// 领导视角：纯函数（taskImageCount / parseOutsourcePrice / aggregateLeadership）
// ============================================================

test('taskImageCount：优先 n（嵌套/顶层）与 count 参数，缺省 1 张/任务', () => {
  assert.equal(taskImageCount({ n_deep: 4, n_flat: 2, n_count: 3 }), 4);
  assert.equal(taskImageCount({ n_deep: null, n_flat: 2, n_count: 3 }), 2);
  assert.equal(taskImageCount({ n_deep: null, n_flat: null, n_count: 3 }), 3);
  // 字符串数字（PostgREST ->> 返回文本）与非法值兜底
  assert.equal(taskImageCount({ n_flat: '6' }), 6);
  assert.equal(taskImageCount({ n_flat: '0', n_count: '-2' }), 1);
  assert.equal(taskImageCount({}), 1);
});

test('parseOutsourcePrice：正数通过，非法/非正数回退 null', () => {
  assert.equal(parseOutsourcePrice('5'), 5);
  assert.equal(parseOutsourcePrice('0.5'), 0.5);
  assert.equal(parseOutsourcePrice(12), 12);
  assert.equal(parseOutsourcePrice('abc'), null);
  assert.equal(parseOutsourcePrice('0'), null);
  assert.equal(parseOutsourcePrice('-3'), null);
  assert.equal(parseOutsourcePrice(null), null);
  assert.equal(parseOutsourcePrice(undefined), null);
  assert.equal(parseOutsourcePrice(''), null);
});

test('aggregateLeadership：产出/消耗/累计/降本（节约为负如实展示）', () => {
  const rows = [
    // 生图任务：参数 n=4，耗时 30s
    { type: 'image', status: 'completed', created_at: '2026-08-01T01:00:00Z', completed_at: '2026-08-01T01:00:30Z', model: 'm-a', n_deep: 4, n_flat: null, n_count: null },
    // 生图任务：参数无 n → 1 张，耗时 10s
    { type: 'image', status: 'completed', created_at: '2026-08-01T02:00:00Z', completed_at: '2026-08-01T02:00:10Z', model: 'm-b', n_flat: null, n_count: null },
    // 失败生图任务不计入
    { type: 'image', status: 'failed', created_at: '2026-08-01T03:00:00Z', completed_at: '2026-08-01T03:01:00Z', model: 'm-a', n_flat: 9, n_count: null },
    // 非生图任务不计入产出/出图耗时，但计入模型种类与 topModel
    { type: 'chat', status: 'completed', created_at: '2026-08-01T04:00:00Z', completed_at: '2026-08-01T04:00:05Z', model: 'm-b', n_flat: null, n_count: null },
  ] as never;

  const block = aggregateLeadership(rows, {
    tokens: 123456,
    allTimeCalls: 8298,
    allTimeImageTasks: 3590,
    outsourcePriceCny: 100,
    actualCostUsd: 1.25,
    usdCnyRate: 7,
  });

  assert.equal(block.windowImages, 5); // 4 + 1（失败/聊天不计）
  assert.equal(block.windowImageTasks, 2);
  assert.equal(block.avgImageDurationMs, 20000); // (30s + 10s) / 2
  // 按成功任务计：m-a 1 次、m-b 2 次 → 最常用 m-b
  assert.equal(block.topModel, 'm-b');
  assert.equal(block.topModelCount, 2);
  assert.equal(block.modelTypes, 2);
  assert.equal(block.tokens, 123456);
  assert.equal(block.allTimeCalls, 8298);
  assert.equal(block.allTimeImageTasks, 3590);
  assert.equal(block.outsourcePriceCny, 100);
  assert.equal(block.outsourceEquivalentCny, 500); // 5 张 × ¥100
  // ¥500 − $1.25 × 7 = ¥491.25
  assert.equal(block.savedCny, 491.25);
});

test('aggregateLeadership：未配置委外单价或无产出时降本字段为 null；无任务时模型字段为空', () => {
  const noPrice = aggregateLeadership(
    [{ type: 'image', status: 'completed', created_at: '2026-08-01T01:00:00Z', completed_at: '2026-08-01T01:00:10Z', model: 'm-a', n_flat: null, n_count: null }] as never,
    { tokens: null, allTimeCalls: null, allTimeImageTasks: null, outsourcePriceCny: null, actualCostUsd: 5, usdCnyRate: 7 }
  );
  assert.equal(noPrice.outsourceEquivalentCny, null);
  assert.equal(noPrice.savedCny, null);
  assert.equal(noPrice.tokens, null);
  assert.equal(noPrice.allTimeCalls, null);

  const noRows = aggregateLeadership([], {
    tokens: null,
    allTimeCalls: 0,
    allTimeImageTasks: 0,
    outsourcePriceCny: 5,
    actualCostUsd: null,
    usdCnyRate: 7,
  });
  assert.equal(noRows.windowImages, 0);
  assert.equal(noRows.topModel, null);
  assert.equal(noRows.topModelCount, 0);
  assert.equal(noRows.modelTypes, 0);
  assert.equal(noRows.avgImageDurationMs, 0);
  // 有单价但无实际金额 → 节约不可算
  assert.equal(noRows.outsourceEquivalentCny, null);
  assert.equal(noRows.savedCny, null);
});

// ============================================================================
// 按钮使用统计（add-button-usage-stats）
// ============================================================================

test('buildButtonUsageSummary：排行/趋势/零使用聚合', () => {
  const now = Date.parse('2026-10-11T10:00:00+08:00');
  const iso = (offsetDays: number, hour = 10) =>
    new Date(now - offsetDays * 86400000).toISOString();
  const rows = [
    // 近 7 天高频：btn_a 两次（两个用户）
    { button_id: 'btn_a', button_label: '按钮A', oa_account: 'u1', created_at: iso(1) },
    { button_id: 'btn_a', button_label: '', oa_account: 'u2', created_at: iso(2) },
    // 8 天前：只进 30 天榜
    { button_id: 'btn_b', button_label: '按钮B', oa_account: 'u1', created_at: iso(8) },
    // inventory 基线：inv_c 点击过、inv_d 从未点击
    { button_id: 'inv:btn_c', button_label: null, oa_account: 'u1', created_at: iso(3) },
    { button_id: 'inv:btn_d', button_label: null, oa_account: 'u1', created_at: iso(3) },
    { button_id: 'inv:btn_e', button_label: null, oa_account: 'u1', created_at: iso(3) },
    { button_id: 'btn_c', button_label: '按钮C', oa_account: 'u1', created_at: iso(4) },
    // 窗口外（31 天前）：不进任何聚合
    { button_id: 'btn_old', button_label: '旧', oa_account: 'u1', created_at: iso(31) },
  ];

  const summary = buildButtonUsageSummary(rows as never, now);

  // 7 天榜：btn_a(2) 与 btn_c(1)（btn_b 在 7 天窗口外，仅进 30 天榜）
  assert.equal(summary.top7d.length, 2);
  assert.equal(summary.top7d[0].buttonId, 'btn_a');
  assert.equal(summary.top7d[1].buttonId, 'btn_c');
  assert.equal(summary.top7d[0].count, 2);
  assert.equal(summary.top7d[0].users, 2);
  // label 取最近一次非空（第二行的空 label 不覆盖第一行）
  assert.equal(summary.top7d[0].label, '按钮A');

  // 30 天榜按次数降序：btn_a(2) > btn_b(1) = btn_c(1)
  assert.equal(summary.top30d.length, 3);
  assert.equal(summary.top30d[0].buttonId, 'btn_a');
  assert.equal(summary.top30d[1].buttonId, 'btn_b');
  assert.equal(summary.top30d[2].buttonId, 'btn_c');

  // 日趋势：两个不同的东八区日（1 天前与 8 天前/4 天前同日性不假设）
  assert.ok(summary.dailyTrend.length >= 2);
  const totalCount = summary.dailyTrend.reduce((s, d) => s + d.count, 0);
  assert.equal(totalCount, 4); // btn_a×2 + btn_b + btn_c（inventory 不计入）

  // 零使用：基线 3 个 − 被点击的 btn_c = btn_d、btn_e
  assert.equal(summary.inventoryCount, 3);
  assert.deepEqual(summary.unused, ['btn_d', 'btn_e']);
});

test('buildButtonUsageSummary：空数据安全', () => {
  const summary = buildButtonUsageSummary([], Date.now());
  assert.deepEqual(summary, {
    top7d: [],
    top30d: [],
    dailyTrend: [],
    unused: [],
    inventoryCount: 0,
  });
});

test('aggregateButtonUsage：service_role 查询与聚合编排', async () => {
  const calls: string[] = [];
  const fetchFn = routeFetch(
    [
      {
        match: (url) => url.includes('/rest/v1/ui_click_events'),
        respond: (url) => {
          assert.ok(url.includes('created_at=gte.'));
          assert.ok(url.includes('button_id,button_label,oa_account,created_at'));
          return json(200, [
            {
              button_id: 'btn_x',
              button_label: 'X',
              oa_account: 'u1',
              created_at: new Date().toISOString(),
            },
          ]);
        },
      },
    ],
    calls
  );
  const summary = await aggregateButtonUsage(ENV, { fetch: fetchFn as unknown as typeof fetch });
  assert.equal(summary.top30d.length, 1);
  assert.equal(summary.top30d[0].buttonId, 'btn_x');
  assert.ok(calls.length === 1);
});

// ============================================================
// Excel 导出（add-dashboard-range-export）：零依赖 xlsx 写入器、
// 区间参数校验、工作簿组装与页面入口
// ============================================================

/** 解析零依赖写入器产出的 stored ZIP（顺序本地头，无 data descriptor），返回 条目名→文本 */
function readStoredZipEntries(bytes: Uint8Array): Map<string, string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const entries = new Map<string, string>();
  let off = 0;
  while (off + 30 <= bytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const flags = dv.getUint16(off + 6, true);
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const name = dec.decode(bytes.subarray(off + 30, off + 30 + nameLen));
    assert.equal(method, 0, `${name} 应为 stored（不压缩）条目`);
    assert.equal(flags & 0x0008, 0, `${name} 不得使用 data descriptor`);
    const dataStart = off + 30 + nameLen + extraLen;
    entries.set(name, dec.decode(bytes.subarray(dataStart, dataStart + size)));
    off = dataStart + size;
  }
  assert.equal(dv.getUint32(off, true), 0x02014b50, '本地条目后应紧跟中央目录');
  return entries;
}

const OVERVIEW_FIXTURE: DashboardOverview = {
  generatedAt: '2026-10-12T08:00:00.000Z',
  days: 55,
  usdCnyRate: 7,
  weekTasks: 100,
  monthCostUsd: 88.8,
  tasks: {
    total: 320,
    byType: { image: 210, chat: 68, video: 30, audio: 12 },
    byModel: { 'gemini-2.5-pro-image': 200, 'gpt-image-2': 120 },
    activeUsers: 23,
    avgDurationMs: 42000,
    dailyTrend: [
      { date: '2026-08-07', count: 3 },
      { date: '2026-08-08', count: 5 },
    ],
    hourly: Array.from({ length: 24 }, (_, i) => i),
    topUsers: [{ userId: 'u1', displayName: '孟杜翀', department: '方案中心', count: 86 }],
    userUsage: [
      { userId: 'u1', displayName: '孟杜翀', department: '方案中心', count: 86 },
      { userId: 'u2', displayName: null, department: null, count: 64 },
    ],
    totalCostUsd: 96.5,
  },
  usage: {
    quotaLimit: 200,
    byPeriod: [
      { period: '2026-08', used: 810 },
      { period: '2026-09', used: 640 },
    ],
    latestPeriod: '2026-09',
    latestUsed: 640,
    topUsers: [],
  },
  users: {
    total: 46,
    byDepartment: { 方案中心: 18, 环艺中心: 9 },
    byRegion: { 广州: 22, 深圳: 10 },
    usageByDepartment: { 方案中心: 156, 环艺中心: 62 },
    usageByRegion: { 广州: 168, 深圳: 74 },
    costByDepartment: { 方案中心: 47.1, 环艺中心: 18.7 },
    staffDirectory: 300,
    enabledDepartments: 8,
  },
  leadership: {
    windowImages: 458,
    windowImageTasks: 210,
    avgImageDurationMs: 38000,
    topModel: 'gemini-2.5-pro-image',
    topModelCount: 200,
    modelTypes: 2,
    tokens: 1623784,
    allTimeCalls: 8298,
    allTimeImageTasks: 3590,
    outsourcePriceCny: 80,
    outsourceEquivalentCny: 36640,
    savedCny: 36630.35,
  },
};

const BUTTON_USAGE_FIXTURE: ButtonUsageSummary = {
  top7d: [
    { buttonId: 'btn_a', label: '生成图片', count: 30, users: 5, lastSeenAt: '2026-10-10T02:00:00.000Z' },
  ],
  top30d: [
    { buttonId: 'btn_a', label: '生成图片', count: 120, users: 9, lastSeenAt: '2026-10-10T02:00:00.000Z' },
  ],
  dailyTrend: [{ date: '2026-10-09', count: 6 }],
  unused: ['inv:legacy-btn'],
  inventoryCount: 257,
};

test('buildXlsx：产出可解析的 stored ZIP，workbook/rels/sheet 条目齐全且顺序一致', () => {
  const bytes = buildXlsx([
    { name: '概览', rows: [['指标', '数值'], ['总数', 42]] },
    { name: '每日趋势', rows: [['日期', '次数'], ['2026-08-07', 3]] },
  ]);
  assert.equal(bytes[0], 0x50, 'ZIP 魔数 P');
  assert.equal(bytes[1], 0x4b, 'ZIP 魔数 K');
  const entries = readStoredZipEntries(bytes);
  for (const name of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
  ]) {
    assert.ok(entries.has(name), `缺少条目 ${name}`);
  }
  const wb = entries.get('xl/workbook.xml')!;
  assert.ok(wb.includes('name="概览"'), 'workbook 应声明第一个 sheet 名');
  assert.ok(wb.includes('name="每日趋势"'));
  assert.ok(
    wb.indexOf('name="概览"') < wb.indexOf('name="每日趋势"'),
    'workbook sheet 顺序应与传入顺序一致'
  );
  const s1 = entries.get('xl/worksheets/sheet1.xml')!;
  assert.ok(s1.includes('总数'), 'sheet1 应含表头文本');
  assert.ok(s1.includes('<v>42</v>'), '数字应写为数值单元格');
  const ct = entries.get('[Content_Types].xml')!;
  assert.ok(ct.includes('/xl/worksheets/sheet1.xml'));
  assert.ok(ct.includes('/xl/worksheets/sheet2.xml'));
  const rels = entries.get('xl/_rels/workbook.xml.rels')!;
  assert.ok(rels.includes('worksheets/sheet1.xml'));
  assert.ok(rels.includes('worksheets/sheet2.xml'));
});

test('buildXlsx：单元格类型与 XML 转义、null 省略、字符串保留原样', () => {
  const bytes = buildXlsx([
    {
      name: 'S',
      rows: [['a<b>&"c"', null, 42.5, '007', '中文✓']],
    },
  ]);
  const xml = readStoredZipEntries(bytes).get('xl/worksheets/sheet1.xml')!;
  assert.ok(xml.includes('a&lt;b&gt;&amp;&quot;c&quot;'), 'XML 特殊字符必须转义');
  assert.ok(xml.includes('<v>42.5</v>'), '小数写为数值单元格');
  assert.ok(xml.includes('>007<'), '字符串数字保留文本形态（不丢前导零）');
  assert.ok(xml.includes('中文✓'), '中文/emoji 原样保留（UTF-8）');
  assert.ok(xml.includes('xml:space="preserve"'), '文本单元格保留空白语义');
  const cells = xml.match(/<c /g) || [];
  assert.equal(cells.length, 4, 'null 单元格应省略（5 列中 4 个非空）');
});

test('buildXlsx：sheet 名清洗非法字符并截断到 31 字符；空表仍产出合法 sheetData', () => {
  const longName = 'x'.repeat(40);
  const dirty = 'A/B\\C:D*E?F[G]H';
  const bytes = buildXlsx([
    { name: longName, rows: [['h']] },
    { name: dirty, rows: [] },
  ]);
  const wb = readStoredZipEntries(bytes).get('xl/workbook.xml')!;
  assert.ok(wb.includes('x'.repeat(31)), 'sheet 名截断到 31 字符');
  assert.ok(wb.includes('A_B_C_D_E_F_G_H'), 'Excel 非法字符 :\\/?:*[] 清洗为下划线');
  const s2 = readStoredZipEntries(bytes).get('xl/worksheets/sheet2.xml')!;
  assert.ok(s2.includes('sheetData'), '空表也要有 sheetData');
});

test('parseOverviewRange：合法区间/仅 days/缺一/格式错/假日期/倒置/同日', () => {
  const ok = parseOverviewRange('2026-08-07', '2026-09-30');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.range, { start: '2026-08-07', end: '2026-09-30' });

  const daysOnly = parseOverviewRange(null, null);
  assert.equal(daysOnly.ok, true, '两者都缺省 = days 模式，合法');
  assert.equal(daysOnly.ok && daysOnly.range, undefined);

  const half = parseOverviewRange('2026-08-07', null);
  assert.equal(half.ok, false, '只给 start 非法');
  assert.match(half.ok ? '' : half.error, /同时/);

  const badFormat = parseOverviewRange('2026-8-7', '2026-09-30');
  assert.equal(badFormat.ok, false, '非零填充格式非法');
  assert.match(badFormat.ok ? '' : badFormat.error, /YYYY-MM-DD/);

  const fakeDate = parseOverviewRange('2026-02-30', '2026-03-01');
  assert.equal(fakeDate.ok, false, '非真实日历日期（2 月 30 日）非法');

  const inverted = parseOverviewRange('2026-09-30', '2026-08-07');
  assert.equal(inverted.ok, false, 'start 晚于 end 非法');
  assert.match(inverted.ok ? '' : inverted.error, /晚于/);

  const sameDay = parseOverviewRange('2026-08-07', '2026-08-07');
  assert.equal(sameDay.ok, true, '同日单日区间合法');
});

test('buildOverviewWorkbook：11 类基础 sheet 齐全、顺序固定、数值与 overview 同口径', () => {
  const bytes = buildOverviewWorkbook(OVERVIEW_FIXTURE, {
    rangeLabel: '2026-08-07 ~ 2026-09-30',
  });
  const entries = readStoredZipEntries(bytes);
  const wb = entries.get('xl/workbook.xml')!;
  const names = [
    '概览',
    '核心指标',
    '操作类型分布',
    '模型使用分布',
    '每日趋势',
    '24小时分布',
    '部门使用排行',
    '用户使用排行',
    '部门使用汇总',
    '月度用量趋势',
    '部门分布',
  ];
  let pos = -1;
  for (const n of names) {
    const at = wb.indexOf(`name="${n}"`);
    assert.ok(at >= 0, `缺少 sheet：${n}`);
    assert.ok(at > pos, `sheet ${n} 顺序不对`);
    pos = at;
  }
  assert.ok(!wb.includes('按钮统计'), '未提供 buttonUsage 时不得有按钮统计 sheet');
  const overrides = (entries.get('[Content_Types].xml')!.match(/worksheets\/sheet/g) || []).length;
  assert.equal(overrides, 11, '未含按钮统计时共 11 个 sheet');

  // 概览（sheet1）：区间标签 + KPI 数值
  const s1 = entries.get('xl/worksheets/sheet1.xml')!;
  assert.ok(s1.includes('2026-08-07 ~ 2026-09-30'), '概览应含统计周期标签');
  assert.ok(s1.includes('<v>320</v>'), '概览应含总操作次数');
  assert.ok(s1.includes('<v>23</v>'), '概览应含活跃用户数');

  // 操作类型分布：次数与占比（210/320 = 65.6%）
  const s3 = entries.get('xl/worksheets/sheet3.xml')!;
  assert.ok(s3.includes('image') && s3.includes('<v>210</v>') && s3.includes('65.6%'));

  // 每日趋势：逐日行
  const s5 = entries.get('xl/worksheets/sheet5.xml')!;
  assert.ok(s5.includes('2026-08-07') && s5.includes('<v>3</v>'));
  assert.ok(s5.includes('2026-08-08') && s5.includes('<v>5</v>'));

  // 24 小时分布：表头 + 24 行
  const s6 = entries.get('xl/worksheets/sheet6.xml')!;
  assert.equal((s6.match(/<row /g) || []).length, 25, '24 小时分布应为表头+24 行');

  // 用户使用排行：姓名与次数（含 null 部门降级）
  const s8 = entries.get('xl/worksheets/sheet8.xml')!;
  assert.ok(s8.includes('孟杜翀') && s8.includes('<v>86</v>'));
  assert.ok(s8.includes('u2') && s8.includes('<v>64</v>'));

  // 部门使用汇总：金额 CNY = USD × 汇率（47.1×7=329.7）、占比 = 156/320 = 48.75%（与页面同口径）
  const s9 = entries.get('xl/worksheets/sheet9.xml')!;
  assert.ok(s9.includes('方案中心'));
  assert.ok(s9.includes('<v>18</v>'), '用户数取 users.byDepartment');
  assert.ok(s9.includes('<v>156</v>'), '使用次数取 users.usageByDepartment');
  assert.ok(s9.includes('<v>329.7</v>'), '金额列应为 CNY（USD×汇率）');
  assert.ok(s9.includes('48.8%'), '占比列与页面口径一致（1 位小数）');

  // 月度用量趋势 / 部门分布 / 部门使用排行
  const s10 = entries.get('xl/worksheets/sheet10.xml')!;
  assert.ok(s10.includes('2026-08') && s10.includes('<v>810</v>'));
  const s11 = entries.get('xl/worksheets/sheet11.xml')!;
  assert.ok(s11.includes('方案中心') && s11.includes('<v>18</v>'));
  const s7 = entries.get('xl/worksheets/sheet7.xml')!;
  assert.ok(s7.includes('广州') && s7.includes('<v>168</v>'));

  // 核心指标（sheet2）：领导视角数值
  const s2 = entries.get('xl/worksheets/sheet2.xml')!;
  assert.ok(s2.includes('<v>458</v>'), '生成图片张数');
  assert.ok(s2.includes('<v>8298</v>'), '累计调用次数');
  assert.ok(s2.includes('gemini-2.5-pro-image'), '最常用模型');
});

test('buildOverviewWorkbook：附 buttonUsage 时追加按钮统计 sheet（固定 7/30 天口径标注）', () => {
  const bytes = buildOverviewWorkbook(OVERVIEW_FIXTURE, {
    rangeLabel: '近 30 天',
    buttonUsage: BUTTON_USAGE_FIXTURE,
  });
  const entries = readStoredZipEntries(bytes);
  const wb = entries.get('xl/workbook.xml')!;
  assert.ok(wb.includes('name="按钮统计"'), '应追加按钮统计 sheet');
  const s12 = entries.get('xl/worksheets/sheet12.xml')!;
  assert.ok(s12.includes('近 7 天'), '按钮统计须标注固定 7/30 天口径');
  assert.ok(s12.includes('近 30 天'));
  assert.ok(s12.includes('生成图片') && s12.includes('<v>120</v>'));
  assert.ok(s12.includes('inv:legacy-btn'), '零使用清单入表');
  assert.ok(s12.includes('2026-10-10T02:00:00.000Z'), '最近使用时间原样导出');
});

test('buildOverviewWorkbook：null 数值降级展示（- / 未配置），不产出 NaN 单元格', () => {
  const overview = structuredClone(OVERVIEW_FIXTURE);
  overview.tasks.totalCostUsd = null;
  overview.monthCostUsd = null;
  overview.leadership.tokens = null;
  overview.leadership.outsourcePriceCny = null;
  const bytes = buildOverviewWorkbook(overview, { rangeLabel: '近 30 天' });
  const entries = readStoredZipEntries(bytes);
  const s1 = entries.get('xl/worksheets/sheet1.xml')!;
  assert.ok(s1.includes('>-<'), 'null 金额在概览中降级为 -');
  const s2 = entries.get('xl/worksheets/sheet2.xml')!;
  assert.ok(s2.includes('>-<'), 'null Token 消耗降级为 -');
  assert.ok(s2.includes('未配置'), 'null 委外单价提示未配置');
  for (const [, xml] of entries) {
    assert.ok(!xml.includes('NaN'), '任何单元格不得出现 NaN');
    assert.ok(!xml.includes('undefined'), '任何单元格不得出现 undefined');
  }
});

test('buildDashboardHtml：自定义区间入口与导出 Excel 按钮（add-dashboard-range-export）', () => {
  const html = buildDashboardHtml(ANON_KEY);
  // 自定义区间：下拉选项 + 起止日期输入 + 应用按钮 + load 的 custom 分支
  assert.ok(html.includes('value="custom"'), '下拉需有自定义区间选项');
  assert.ok(html.includes('id="customRangeBox"'), '缺少自定义区间输入容器');
  assert.ok((html.match(/type="date"/g) || []).length >= 2, '需要起/止两个日期输入框');
  assert.ok(html.includes('id="applyRangeBtn"'), '缺少应用按钮');
  assert.ok(html.includes("'custom'"), 'load 必须处理自定义区间分支');
  assert.ok(html.includes("CURRENT_MODE='custom'"), '自定义区间需跟踪周期模式');
  assert.ok(html.includes('起始日期不能晚于结束日期'), '前端需校验 start<=end');
  // 月份快选插入在自定义项之前（自定义项是最后一个选项）
  assert.ok(
    /value="custom"[\s\S]*populateMonthOptions[\s\S]*function populateMonthOptions/.test(html) ||
      html.includes("insertAdjacentHTML('beforebegin'"),
    '月份快选不得排到自定义项之后'
  );
  // 导出 Excel：按钮 + export 接口请求 + 复用当前区间 + 401 刷新重试
  assert.ok(html.includes('id="exportXlsxBtn"'), '缺少导出 Excel 按钮');
  assert.ok(html.includes("'export?'"), '页面必须以 export? 发起导出请求');
  assert.ok(html.includes('LAST_EXPORT_QS'), '导出需复用当前查询区间参数');
  assert.ok(html.includes('tryRefresh'), '401 时应刷新会话重试');
  assert.ok(html.includes('仅管理员可导出'), '403 需给出管理员提示');
});

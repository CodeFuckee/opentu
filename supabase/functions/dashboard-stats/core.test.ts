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
  aggregateUsage,
  aggregateUsers,
  countTaskFiles,
  readQuotaLimit,
  fetchBucketStats,
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

test('aggregateTasks：总量/分布/成功率/趋势/平均耗时', () => {
  const rows = [
    { type: 'image', status: 'completed', created_at: '2026-08-01T01:00:00Z', completed_at: '2026-08-01T01:00:10Z', file_paths: ['a'], response_file_paths: ['b', 'c'] },
    { type: 'image', status: 'completed', created_at: '2026-08-01T02:00:00Z', completed_at: '2026-08-01T02:00:30Z', file_paths: [], response_file_paths: [] },
    { type: 'video', status: 'failed', created_at: '2026-08-02T03:00:00Z', completed_at: '2026-08-02T03:05:00Z', file_paths: ['x'], response_file_paths: [] },
    { type: 'chat', status: 'cancelled', created_at: '2026-08-02T04:00:00Z', completed_at: null, file_paths: [], response_file_paths: [] },
  ] as never;

  const stats = aggregateTasks(rows);
  assert.equal(stats.total, 4);
  assert.deepEqual(stats.byType, { image: 2, video: 1, chat: 1 });
  assert.deepEqual(stats.byStatus, { completed: 2, failed: 1, cancelled: 1 });
  assert.equal(stats.successRate, 2 / 3);
  // 平均耗时：(10 + 30) / 2 = 20s
  assert.equal(stats.avgDurationMs, 20000);
  assert.deepEqual(stats.dailyTrend, [
    { date: '2026-08-01', count: 2 },
    { date: '2026-08-02', count: 2 },
  ]);
});

test('countTaskFiles：jsonb 数组长度求和', () => {
  const rows = [
    { file_paths: ['a.png', 'b.png'], response_file_paths: ['o.png'] },
    { file_paths: [], response_file_paths: ['o2.png', 'o3.png'] },
  ] as never;
  assert.deepEqual(countTaskFiles(rows), { input: 2, output: 3 });
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

  const result = aggregateUsage(usage, profiles as never, 200);
  assert.equal(result.quotaLimit, 200);
  assert.deepEqual(result.byPeriod, [
    { period: '2026-07-01', used: 5 },
    { period: '2026-08-01', used: 40 },
  ]);
  assert.equal(result.latestPeriod, '2026-08-01');
  assert.equal(result.latestUsed, 40);
  assert.deepEqual(result.topUsers, [
    { oaAccount: 'bob', department: '设计部', used: 30 },
    { oaAccount: 'alice', department: '技术部', used: 10 },
  ]);
});

test('aggregateUsers：总数/部门/区域/最近注册/花名册/可用部门', () => {
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
  assert.deepEqual(result.recent.map((r) => r.oaAccount), ['b', 'c', 'a']);
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

test('fetchBucketStats：分页累加对象数与字节数；失败返回 null', async () => {
  const itemsPage1 = Array.from({ length: 1000 }, (_, i) => ({
    name: `f${i}.png`,
    metadata: { size: 100 },
  }));
  const calls: string[] = [];
  const okFetch = routeFetch(
    [
      {
        match: (url) => url.includes('/storage/v1/object/list/huabu'),
        respond: (_url, init) => {
          const body = JSON.parse(String((init as RequestInit).body));
          const offset = Number(body.offset);
          return json(200, offset === 0 ? itemsPage1 : []);
        },
      },
    ],
    calls
  );
  assert.deepEqual(await fetchBucketStats(ENV, { fetch: okFetch }), {
    objects: 1000,
    bytes: 100000,
  });
  assert.ok(calls.some((u) => u.includes('/storage/v1/object/list/huabu')));

  const badFetch = routeFetch([], []);
  assert.equal(await fetchBucketStats(ENV, { fetch: badFetch }), null);
});

test('aggregateOverview：编排各 REST 查询并返回四类聚合', async () => {
  const calls: string[] = [];
  const fetchImpl = routeFetch(
    [
      {
        match: (url) => url.includes('/rest/v1/task_submissions'),
        respond: () =>
          json(200, [
            { type: 'image', status: 'completed', created_at: '2026-08-01T01:00:00Z', completed_at: '2026-08-01T01:00:05Z', file_paths: ['a'], response_file_paths: ['o'] },
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
          json(200, [], { 'Content-Range': '0-0/320' }),
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
        match: (url) => url.includes('/storage/v1/object/list/huabu'),
        respond: () => json(200, [{ name: 'x.png', metadata: { size: 42 } }]),
      },
    ],
    calls
  );

  const overview = await aggregateOverview(ENV, 30, { fetch: fetchImpl });

  assert.equal(overview.tasks.total, 1);
  assert.equal(overview.usage.latestUsed, 12);
  assert.equal(overview.users.total, 1);
  assert.equal(overview.users.staffDirectory, 320);
  assert.equal(overview.storage.inputFiles, 1);
  assert.equal(overview.storage.outputFiles, 1);
  assert.deepEqual(overview.storage.bucket, { objects: 1, bytes: 42 });

  // 所有 REST 请求都应携带 service_role 身份头
  for (const url of calls) {
    assert.ok(
      url.startsWith('http://supabase.local/'),
      `unexpected url: ${url}`
    );
  }
  const authHeaders = calls
    .map((url) => url)
    .filter((url) => url.includes('/rest/v1/'));
  assert.ok(authHeaders.length >= 5);
});

test('buildDashboardHtml：自包含页面，内嵌 anon key，无外部脚本依赖', () => {
  const html = buildDashboardHtml(DEFAULT_ANON_KEY);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('数据看板'));
  assert.ok(html.includes('overview?days='));
  assert.ok(html.includes(DEFAULT_ANON_KEY));
  assert.ok(!/<script[^>]+src=/i.test(html), '页面不得引用外部脚本');
  assert.ok(!/<link[^>]+href=/i.test(html), '页面不得引用外部样式');
});

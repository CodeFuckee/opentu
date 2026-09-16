/**
 * task-monitor Edge Function unit tests (node:test)
 *
 * 场景：验证「生图任务是否仍会在 60s 被 edge-runtime 杀死」的聚合逻辑——
 * WorkerRequestCancelled 特征识别、修复前后分界计数、>60s 完成样本、
 * 以及鉴权与参数解析。
 *
 * Run: node --test supabase/functions/task-monitor/core.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate,
  buildCompletedSliceUrl,
  buildFailedSliceUrl,
  extractBearerToken,
  handleTaskMonitor,
  isWorkerCancelledKill,
  parseWindowHours,
  durationSeconds,
  FIX_DEPLOYED_AT,
  MAX_WINDOW_HOURS,
  type CompletedTaskRow,
  type FailedTaskRow,
} from './core.ts';

const BEFORE_FIX = '2026-09-15T01:58:27Z'; // 修复部署前被杀的任务
const AFTER_FIX = '2026-09-15T05:00:00Z'; // 修复部署后

function killedRow(createdAt: string, taskId = 'killed-task'): FailedTaskRow {
  return {
    task_id: taskId,
    created_at: createdAt,
    completed_at: createdAt,
    error: { code: 'EXECUTION_ERROR', message: 'Tuzi GPT Image request failed: 500' },
    upstream_response: {
      msg: 'WorkerRequestCancelled: request has been cancelled by supervisor',
    },
  };
}

function plainFailureRow(createdAt: string, taskId = 'quota-task'): FailedTaskRow {
  return {
    task_id: taskId,
    created_at: createdAt,
    completed_at: createdAt,
    error: {
      code: 'insufficient_user_quota',
      message: '预扣费额度失败',
    },
  };
}

function completedRow(
  createdAt: string,
  completedAt: string,
  taskId: string
): CompletedTaskRow {
  return { task_id: taskId, created_at: createdAt, completed_at: completedAt };
}

describe('parseWindowHours', () => {
  test('缺省/非法回退 24', () => {
    assert.equal(parseWindowHours(undefined), 24);
    assert.equal(parseWindowHours('abc'), 24);
    assert.equal(parseWindowHours(0), 24);
    assert.equal(parseWindowHours(-5), 24);
  });

  test('合法值取整，超上限截断', () => {
    assert.equal(parseWindowHours('72'), 72);
    assert.equal(parseWindowHours(72.9), 72);
    assert.equal(parseWindowHours(9999), MAX_WINDOW_HOURS);
  });
});

describe('isWorkerCancelledKill / durationSeconds / extractBearerToken', () => {
  test('upstream_response 含 WorkerRequestCancelled 判定为被杀', () => {
    assert.equal(isWorkerCancelledKill(killedRow(BEFORE_FIX)), true);
  });

  test('普通额度失败与仅兜底文案不判定为被杀', () => {
    assert.equal(isWorkerCancelledKill(plainFailureRow(BEFORE_FIX)), false);
    assert.equal(
      isWorkerCancelledKill({
        task_id: 't',
        created_at: BEFORE_FIX,
        completed_at: BEFORE_FIX,
        error: { code: 'EXECUTION_ERROR', message: 'Tuzi GPT Image request failed: 500' },
      }),
      false
    );
  });

  test('durationSeconds 计算秒差，缺失时间返回 null', () => {
    assert.equal(durationSeconds('2026-09-15T00:00:00Z', '2026-09-15T00:02:03Z'), 123);
    assert.equal(durationSeconds('2026-09-15T00:00:00Z', null), null);
  });

  test('extractBearerToken 解析 Bearer 头', () => {
    assert.equal(extractBearerToken('Bearer abc.def'), 'abc.def');
    assert.equal(extractBearerToken(null), null);
    assert.equal(extractBearerToken('Token abc'), null);
  });
});

describe('aggregate', () => {
  const sinceIso = '2026-09-14T00:00:00Z';

  test('修复前后被杀计数与 >60s 完成样本', () => {
    const failedRows: FailedTaskRow[] = [
      killedRow(BEFORE_FIX, 'k1'),
      killedRow(AFTER_FIX, 'k2'),
      plainFailureRow(AFTER_FIX, 'q1'),
    ];
    const completedRows: CompletedTaskRow[] = [
      completedRow('2026-09-15T04:00:00Z', '2026-09-15T04:03:00Z', 'ok180'),
      completedRow('2026-09-15T04:10:00Z', '2026-09-15T04:10:40Z', 'ok40'),
      completedRow(AFTER_FIX, '2026-09-15T05:05:00Z', 'ok300'),
    ];

    const report = aggregate(24, sinceIso, failedRows, completedRows);

    assert.equal(report.counts.completed, 3);
    assert.equal(report.counts.completedOver60s, 2);
    assert.equal(report.counts.failed, 3);
    assert.equal(report.counts.killedTotal, 2);
    assert.equal(report.counts.killedAfterFix, 1);
    assert.equal(report.maxCompletedDurationSec, 300);
    assert.equal(report.longTaskSamples[0].taskId, 'ok300');
    assert.equal(report.longTaskSamples.length, 2);
    assert.match(report.conclusion, /未根治/);
  });

  test('仅有修复前被杀记录时给出补充样本提示', () => {
    const report = aggregate(24, sinceIso, [killedRow(BEFORE_FIX)], []);
    assert.equal(report.counts.killedAfterFix, 0);
    assert.match(report.conclusion, /修复部署前/);
  });

  test('窗口内无任何被杀且无长任务时的中性结论', () => {
    const report = aggregate(
      24,
      sinceIso,
      [plainFailureRow(AFTER_FIX)],
      [completedRow(AFTER_FIX, '2026-09-15T05:00:30Z', 'ok30')]
    );
    assert.match(report.conclusion, /无被杀记录/);
  });

  test('修复后无被杀且有 >60s 完成样本 → 修复生效', () => {
    const report = aggregate(
      24,
      sinceIso,
      [killedRow(BEFORE_FIX)],
      [completedRow(AFTER_FIX, '2026-09-15T05:06:30Z', 'ok390')]
    );
    assert.match(report.conclusion, /修复生效/);
  });
});

describe('handleTaskMonitor', () => {
  const env = {
    SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_URL: 'http://api-gw:8000',
  };

  const ADMIN_EMAIL = 'chenkaidi@example.com';
  const NON_ADMIN_EMAIL = 'normaluser@example.com';

  function mockFetch(
    failedRows: FailedTaskRow[],
    completedRows: CompletedTaskRow[],
    authOk = true,
    opts: { email?: string; admins?: string[]; configsOk?: boolean } = {}
  ) {
    const email = opts.email ?? ADMIN_EMAIL;
    const admins = opts.admins ?? ['chenkaidi'];
    const configsOk = opts.configsOk ?? true;
    return async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/auth/v1/user')) {
        return new Response(
          JSON.stringify(authOk ? { id: 'u1', email } : {}),
          { status: authOk ? 200 : 401 }
        );
      }
      if (url.includes('/rest/v1/configs')) {
        return new Response(
          configsOk ? JSON.stringify(admins.map((value) => ({ value }))) : 'boom',
          { status: configsOk ? 200 : 500 }
        );
      }
      if (url.includes('status=eq.failed')) {
        return new Response(JSON.stringify(failedRows), { status: 200 });
      }
      if (url.includes('status=eq.completed')) {
        return new Response(JSON.stringify(completedRows), { status: 200 });
      }
      return new Response('unexpected', { status: 404 });
    };
  }

  test('OPTIONS 预检返回 204', async () => {
    const res = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor', { method: 'OPTIONS' }),
      env
    );
    assert.equal(res.status, 204);
  });

  test('缺少 Bearer token 返回 401', async () => {
    const res = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor', { method: 'GET' }),
      env
    );
    assert.equal(res.status, 401);
  });

  test('无效 JWT 返回 401', async () => {
    const res = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor', {
        method: 'GET',
        headers: { Authorization: 'Bearer bad-token' },
      }),
      env,
      { fetch: mockFetch([], [], false) }
    );
    assert.equal(res.status, 401);
  });

  test('非管理员用户返回 403（报表含全量用户任务，仅限管理员）', async () => {
    const res = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor', {
        method: 'GET',
        headers: { Authorization: 'Bearer user-token' },
      }),
      env,
      { fetch: mockFetch([], [], true, { email: NON_ADMIN_EMAIL }) }
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /admin only/);
  });

  test('无邮箱身份（如 service role token）返回 403', async () => {
    const res = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor', {
        method: 'GET',
        headers: { Authorization: 'Bearer svc-token' },
      }),
      env,
      { fetch: mockFetch([], [], true, { email: '' }) }
    );
    assert.equal(res.status, 403);
  });

  test('管理员名单查询失败时 fail-closed 返回 403', async () => {
    const res = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor', {
        method: 'GET',
        headers: { Authorization: 'Bearer good-token' },
      }),
      env,
      { fetch: mockFetch([], [], true, { configsOk: false }) }
    );
    assert.equal(res.status, 403);
  });

  test('回退名单 TEMPLATE_CRAWLER_ADMINS 内的账号放行', async () => {
    const res = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor?hours=24', {
        method: 'GET',
        headers: { Authorization: 'Bearer good-token' },
      }),
      env,
      {
        fetch: mockFetch([plainFailureRow(AFTER_FIX)], [], true, {
          admins: [],
        }),
      }
    );
    assert.equal(res.status, 403);

    const res2 = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor?hours=24', {
        method: 'GET',
        headers: { Authorization: 'Bearer good-token' },
      }),
      env,
      {
        fetch: mockFetch(
          [plainFailureRow(AFTER_FIX)],
          [completedRow(AFTER_FIX, '2026-09-15T05:00:30Z', 'ok30')],
          true,
          { admins: ['someoneelse', 'chenkaidi'] }
        ),
      }
    );
    assert.equal(res2.status, 200);
    const body = (await res2.json()) as { counts: Record<string, number> };
    assert.equal(body.counts.completed, 1);
  });

  test('GET + hours 参数返回聚合报告', async () => {
    const res = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor?hours=48', {
        method: 'GET',
        headers: { Authorization: 'Bearer good-token' },
      }),
      env,
      {
        fetch: mockFetch(
          [killedRow(BEFORE_FIX, 'k1'), plainFailureRow(AFTER_FIX, 'q1')],
          [completedRow(AFTER_FIX, '2026-09-15T05:06:30Z', 'ok390')]
        ),
      }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      windowHours: number;
      counts: Record<string, number>;
      conclusion: string;
    };
    assert.equal(body.windowHours, 48);
    assert.equal(body.counts.failed, 2);
    assert.equal(body.counts.killedTotal, 1);
    assert.equal(body.counts.completedOver60s, 1);
    assert.match(body.conclusion, /修复生效/);
  });

  test('POST body 解析 hours，非法 body 回退默认窗口', async () => {
    const res = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor', {
        method: 'POST',
        headers: { Authorization: 'Bearer good-token' },
        body: JSON.stringify({ hours: 6 }),
      }),
      env,
      { fetch: mockFetch([], []) }
    );
    const body = (await res.json()) as { windowHours: number };
    assert.equal(body.windowHours, 6);

    const badRes = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor', {
        method: 'POST',
        headers: { Authorization: 'Bearer good-token' },
        body: 'not-json',
      }),
      env,
      { fetch: mockFetch([], []) }
    );
    const badBody = (await badRes.json()) as { windowHours: number };
    assert.equal(badBody.windowHours, 24);
  });

  test('PostgREST 失败返回 500 与错误信息', async () => {
    const res = await handleTaskMonitor(
      new Request('http://x/functions/v1/task-monitor', {
        method: 'GET',
        headers: { Authorization: 'Bearer good-token' },
      }),
      env,
      {
        fetch: async (input: RequestInfo | URL): Promise<Response> => {
          const url = String(input);
          if (url.includes('/auth/v1/user')) {
            return new Response(
              JSON.stringify({ id: 'u1', email: ADMIN_EMAIL }),
              { status: 200 }
            );
          }
          if (url.includes('/rest/v1/configs')) {
            return new Response(JSON.stringify([{ value: 'chenkaidi' }]), {
              status: 200,
            });
          }
          return new Response('boom', { status: 500 });
        },
      }
    );
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /PostgREST request failed: 500/);
  });

  test('URL 构造包含窗口起点与过滤条件', () => {
    const failedUrl = buildFailedSliceUrl('http://api-gw:8000/', '2026-09-14T00:00:00Z');
    const completedUrl = buildCompletedSliceUrl('http://api-gw:8000/', '2026-09-14T00:00:00Z');
    assert.ok(failedUrl.includes('status=eq.failed'));
    assert.ok(failedUrl.includes('created_at=gte.2026-09-14T00%3A00%3A00Z'));
    assert.ok(completedUrl.includes('select=task_id%2Ccreated_at%2Ccompleted_at'));
    assert.ok(completedUrl.includes('type=eq.image'));
  });

  test('FIX_DEPLOYED_AT 为合法 UTC 时间', () => {
    assert.ok(Number.isFinite(Date.parse(FIX_DEPLOYED_AT)));
  });
});

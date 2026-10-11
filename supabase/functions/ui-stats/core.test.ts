/**
 * ui-stats Edge Function 单测（node:test）
 *
 * 覆盖：
 * - verifyUser：JWT 缺失/无效 401、邮箱前缀解析 oa_account、无邮箱回退 anonymous
 * - normalizeEvents：空/超批量 400、字段缺失 400、长度截断、列名映射
 * - ingestEvents 编排：合法批量写入（oa_account 服务端覆写）、上游失败 502、
 *   非法 JSON body 400
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBearerToken,
  ingestEvents,
  MAX_EVENTS_PER_BATCH,
  normalizeEvents,
  oaAccountFromEmail,
  verifyUser,
  type UiStatsEnv,
} from './core.ts';

const ENV: UiStatsEnv = {
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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function authRoute(email: string | null, ok = true): Route {
  return {
    match: (url) => url === 'http://supabase.local/auth/v1/user',
    respond: () =>
      ok ? json(200, { email }) : json(401, { msg: 'invalid' }),
  };
}

const AUTHED = 'Bearer good-jwt';

function ingestRequest(body: unknown, authorization = AUTHED): Request {
  return new Request('http://supabase.local/functions/v1/ui-stats/ingest', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('extractBearerToken 解析 Bearer 头', () => {
  assert.equal(extractBearerToken('Bearer abc'), 'abc');
  assert.equal(extractBearerToken('bearer abc'), 'abc');
  assert.equal(extractBearerToken(null), null);
  assert.equal(extractBearerToken('Basic abc'), null);
});

test('oaAccountFromEmail 取 @ 前缀，无邮箱回退 anonymous', () => {
  assert.equal(oaAccountFromEmail('zhangsan@corp.internal'), 'zhangsan');
  assert.equal(oaAccountFromEmail('no-at-sign'), 'no-at-sign');
  assert.equal(oaAccountFromEmail(null), 'anonymous');
  assert.equal(oaAccountFromEmail(''), 'anonymous');
});

test('verifyUser：JWT 缺失 401', async () => {
  const result = await verifyUser(
    ENV,
    new Request('http://x/ingest', { method: 'POST' })
  );
  assert.deepEqual(result, { ok: false, status: 401, error: 'unauthorized: missing bearer token' });
});

test('verifyUser：无效 JWT 401（/auth/v1/user 拒绝）', async () => {
  const calls: string[] = [];
  const result = await verifyUser(ENV, ingestRequest({}, 'Bearer bad'), {
    fetch: routeFetch([authRoute(null, false)], calls),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 401);
});

test('verifyUser：有效 JWT 解析 oa_account', async () => {
  const result = await verifyUser(ENV, ingestRequest({}), {
    fetch: routeFetch([authRoute('lisi@corp.internal')], []),
  });
  assert.deepEqual(result, { ok: true, oaAccount: 'lisi' });
});

test('normalizeEvents：空数组与超批量 400', () => {
  assert.equal(normalizeEvents([]).ok, false);
  const tooMany = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => ({
    page: '/',
    buttonId: 'b',
  }));
  const result = normalizeEvents(tooMany);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 400);
});

test('normalizeEvents：字段缺失 400', () => {
  assert.equal(normalizeEvents([{ page: '/' }]).ok, false);
  assert.equal(normalizeEvents([{ buttonId: 'b' }]).ok, false);
  assert.equal(normalizeEvents('not-array').ok, false);
});

test('normalizeEvents：合法事件映射 snake_case 列并截断超长字段', () => {
  const result = normalizeEvents([
    {
      page: '/canvas',
      buttonId: 'toolbar_click_delete',
      buttonLabel: '删除'.repeat(300),
      appVersion: '1.0.10',
    },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0], {
      page: '/canvas',
      button_id: 'toolbar_click_delete',
      button_label: '删除'.repeat(100),
      app_version: '1.0.10',
    });
  }
});

test('ingestEvents：合法批量写入，oa_account 以服务端解析覆写', async () => {
  const calls: string[] = [];
  let insertedBody: unknown = null;
  const insertRoute: Route = {
    match: (url) => url === 'http://supabase.local/rest/v1/ui_click_events',
    respond: (_url, init) => {
      insertedBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 201 });
    },
  };
  const result = await ingestEvents(ENV, ingestRequest({
    events: [
      { page: '/', buttonId: 'a', buttonLabel: 'A' },
      { page: '/x', buttonId: 'inv:b' },
      { page: '/x', buttonId: 'c', appVersion: '1.0.10' },
    ],
  }), {
    fetch: routeFetch([authRoute('wangwu@corp.internal'), insertRoute], calls),
  });
  assert.deepEqual(result, { ok: true, inserted: 3 });
  assert.ok(Array.isArray(insertedBody));
  if (Array.isArray(insertedBody)) {
    assert.equal(insertedBody.length, 3);
    assert.ok(insertedBody.every((row) => (row as Record<string, string>).oa_account === 'wangwu'));
  }
  assert.ok(calls.some((c) => c === 'http://supabase.local/rest/v1/ui_click_events'));
});

test('ingestEvents：字段缺失 400 且不触达插入', async () => {
  const calls: string[] = [];
  const result = await ingestEvents(ENV, ingestRequest({ events: [{ page: '/' }] }), {
    fetch: routeFetch([authRoute('a@x'), {
      match: (url) => url.includes('/rest/v1/ui_click_events'),
      respond: () => new Response(null, { status: 201 }),
    }], calls),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 400);
  assert.ok(!calls.some((c) => c.includes('/rest/v1/ui_click_events')));
});

test('ingestEvents：上游插入失败 502', async () => {
  const result = await ingestEvents(ENV, ingestRequest({
    events: [{ page: '/', buttonId: 'a' }],
  }), {
    fetch: routeFetch([authRoute('a@x'), {
      match: (url) => url.includes('/rest/v1/ui_click_events'),
      respond: () => json(500, { message: 'db down' }),
    }], []),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 502);
});

test('ingestEvents：非法 JSON body 400', async () => {
  const result = await ingestEvents(ENV, ingestRequest('{not-json'), {
    fetch: routeFetch([authRoute('a@x')], []),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 400);
});

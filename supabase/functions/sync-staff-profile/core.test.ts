/**
 * sync-staff-profile Edge Function 单测（node:test）
 *
 * 覆盖：
 * - 命中 staff_directory → upsert user_profiles + 更新 user_metadata
 * - staff_directory 无此 oa账号 → synced:false，无副作用
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncStaffProfile } from './core.ts';

const SUPABASE_URL = 'http://supabase.local';
const SRK = 'service-role-key';

function jsonFetchMock(
  handler: (url: string, init?: RequestInit) => {
    status: number;
    body: unknown;
  }
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const result = handler(url, init);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('命中 staff_directory → upsert user_profiles + 更新 user_metadata', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = jsonFetchMock((url, init) => {
    calls.push({ url, init });
    if (url.includes('/rest/v1/staff_directory')) {
      return {
        status: 200,
        body: [
          {
            department: '方案中心',
            region: '方案设计所',
            position: '方案专业总监',
            name: '潘勇',
            oa_account: 'panyong',
          },
        ],
      };
    }
    if (url.includes('/rest/v1/user_profiles')) {
      return { status: 201, body: [] };
    }
    if (url.includes('/auth/v1/admin/users')) {
      return { status: 200, body: { id: 'user-1' } };
    }
    return { status: 200, body: {} };
  });

  const result = await syncStaffProfile(
    SUPABASE_URL,
    SRK,
    'user-1',
    'panyong',
    { fetch: fetchMock }
  );
  assert.equal(result.synced, true);
  assert.equal(result.staff?.name, '潘勇');

  // upsert user_profiles 的 body 含全部字段
  const upsertCall = calls.find((c) => c.url.includes('/rest/v1/user_profiles'));
  assert.ok(upsertCall, '应调用 upsert user_profiles');
  const body = JSON.parse(String(upsertCall.init?.body));
  assert.equal(body.user_id, 'user-1');
  assert.equal(body.department, '方案中心');
  assert.equal(body.region, '方案设计所');
  assert.equal(body.position, '方案专业总监');
  assert.equal(body.oa_account, 'panyong');

  // 更新 user_metadata 的 body
  const metaCall = calls.find((c) => c.url.includes('/auth/v1/admin/users'));
  assert.ok(metaCall, '应调用 admin 更新 user_metadata');
  const metaBody = JSON.parse(String(metaCall.init?.body));
  assert.equal(metaBody.user_metadata.full_name, '潘勇');
  assert.equal(metaBody.user_metadata.department, '方案中心');
});

test('staff_directory 无此 oa账号 → synced:false，不产生写操作', async () => {
  const calls: string[] = [];
  const fetchMock = jsonFetchMock((url) => {
    calls.push(url);
    if (url.includes('/rest/v1/staff_directory')) {
      return { status: 200, body: [] };
    }
    return { status: 200, body: {} };
  });

  const result = await syncStaffProfile(
    SUPABASE_URL,
    SRK,
    'user-1',
    'nobody',
    { fetch: fetchMock }
  );
  assert.deepEqual(result, { synced: false });
  // 不应有 user_profiles 或 admin 写调用
  assert.ok(!calls.some((u) => u.includes('/rest/v1/user_profiles')));
  assert.ok(!calls.some((u) => u.includes('/auth/v1/admin/users')));
});

test('用户信息缺失（staff_directory 查询失败）→ 抛错', async () => {
  const fetchMock = jsonFetchMock((url) => {
    if (url.includes('/rest/v1/staff_directory')) {
      return { status: 500, body: { message: 'boom' } };
    }
    return { status: 200, body: {} };
  });

  await assert.rejects(
    () =>
      syncStaffProfile(SUPABASE_URL, SRK, 'user-1', 'panyong', {
        fetch: fetchMock,
      }),
    /request failed/
  );
});

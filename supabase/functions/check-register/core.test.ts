/**
 * check-register Edge Function 单测（node:test）
 *
 * 覆盖三类结果：
 * - oa账号不在 staff_directory → not-staff
 * - 在 staff_directory 但部门 enabled=false → department-disabled
 * - 在 staff_directory 且部门 enabled=true → eligible
 * - 部门未登记（找不到 departments 行）→ department-disabled
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRegisterEligibility } from './core.ts';

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

test('oa账号不在 staff_directory → not-staff', async () => {
  const fetchMock = jsonFetchMock((url) => {
    if (url.includes('/rest/v1/staff_directory')) {
      return { status: 200, body: [] };
    }
    return { status: 200, body: [] };
  });
  const result = await checkRegisterEligibility(
    SUPABASE_URL,
    SRK,
    'nobody',
    { fetch: fetchMock }
  );
  assert.deepEqual(result, { eligible: false, reason: 'not-staff' });
});

test('在 staff_directory 但部门 enabled=false → department-disabled', async () => {
  const fetchMock = jsonFetchMock((url) => {
    if (url.includes('/rest/v1/staff_directory')) {
      return {
        status: 200,
        body: [{ oa_account: 'lingjiabin', department: '工程中心' }],
      };
    }
    if (url.includes('/rest/v1/departments')) {
      return { status: 200, body: [{ name: '工程中心', enabled: false }] };
    }
    return { status: 200, body: [] };
  });
  const result = await checkRegisterEligibility(
    SUPABASE_URL,
    SRK,
    'lingjiabin',
    { fetch: fetchMock }
  );
  assert.deepEqual(result, {
    eligible: false,
    reason: 'department-disabled',
  });
});

test('在 staff_directory 且部门 enabled=true → eligible', async () => {
  const fetchMock = jsonFetchMock((url) => {
    if (url.includes('/rest/v1/staff_directory')) {
      return {
        status: 200,
        body: [{ oa_account: 'panyong', department: '方案中心' }],
      };
    }
    if (url.includes('/rest/v1/departments')) {
      return { status: 200, body: [{ name: '方案中心', enabled: true }] };
    }
    return { status: 200, body: [] };
  });
  const result = await checkRegisterEligibility(
    SUPABASE_URL,
    SRK,
    'panyong',
    { fetch: fetchMock }
  );
  assert.deepEqual(result, { eligible: true });
});

test('在 staff_directory 但部门未登记（找不到 departments 行）→ department-disabled', async () => {
  const fetchMock = jsonFetchMock((url) => {
    if (url.includes('/rest/v1/staff_directory')) {
      return {
        status: 200,
        body: [{ oa_account: 'someone', department: '未登记部门' }],
      };
    }
    if (url.includes('/rest/v1/departments')) {
      return { status: 200, body: [] };
    }
    return { status: 200, body: [] };
  });
  const result = await checkRegisterEligibility(
    SUPABASE_URL,
    SRK,
    'someone',
    { fetch: fetchMock }
  );
  assert.deepEqual(result, {
    eligible: false,
    reason: 'department-disabled',
  });
});

test('oa账号大小写不敏感匹配（数据库端已小写存储，查询按输入）', async () => {
  const fetchMock = jsonFetchMock((url) => {
    if (url.includes('/rest/v1/staff_directory')) {
      return {
        status: 200,
        body: [{ oa_account: 'panyong', department: '方案中心' }],
      };
    }
    if (url.includes('/rest/v1/departments')) {
      return { status: 200, body: [{ name: '方案中心', enabled: true }] };
    }
    return { status: 200, body: [] };
  });
  const result = await checkRegisterEligibility(
    SUPABASE_URL,
    SRK,
    'panyong',
    { fetch: fetchMock }
  );
  assert.deepEqual(result, { eligible: true });
});

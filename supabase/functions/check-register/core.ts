/**
 * check-register Edge Function core logic (no Deno dependency, unit-testable)
 *
 * 注册资格校验：
 * 1. oa账号 不在 staff_directory → { eligible: false, reason: 'not-staff' }
 * 2. 在 staff_directory，但其 department 对应 departments.enabled=false
 *    → { eligible: false, reason: 'department-disabled' }
 * 3. 在 staff_directory 且部门 enabled=true → { eligible: true }
 *
 * staff_directory 无 RLS 策略（anon 不可读），因此用 service_role 通过 PostgREST 查询。
 */

export interface CheckRegisterDeps {
  /** 注入 HTTP 客户端便于测试；默认 global fetch */
  fetch?: typeof fetch;
}

export interface CheckRegisterEnv {
  SERVICE_ROLE_KEY: string;
  SUPABASE_URL: string;
}

export type RegisterEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'not-staff' | 'department-disabled' };

interface StaffRow {
  oa_account: string;
  department: string;
}

interface DepartmentRow {
  name: string;
  enabled: boolean;
}

async function getJson(
  url: string,
  serviceRoleKey: string,
  deps: CheckRegisterDeps
): Promise<any> {
  const doFetch = deps.fetch || fetch;
  const response = await doFetch(url, {
    method: 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(
      `query failed: ${response.status} ${(await response.text()).slice(0, 200)}`
    );
  }
  return response.json();
}

/** 按 oa_account 查 staff_directory */
async function findStaff(
  supabaseUrl: string,
  serviceRoleKey: string,
  oaAccount: string,
  deps: CheckRegisterDeps
): Promise<StaffRow | null> {
  const base = `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/staff_directory`;
  const url = `${base}?oa_account=eq.${encodeURIComponent(oaAccount)}&select=oa_account,department&limit=1`;
  const rows = (await getJson(url, serviceRoleKey, deps)) as StaffRow[];
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** 按部门名查 departments（enabled） */
async function findDepartment(
  supabaseUrl: string,
  serviceRoleKey: string,
  name: string,
  deps: CheckRegisterDeps
): Promise<DepartmentRow | null> {
  const base = `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/departments`;
  const url = `${base}?name=eq.${encodeURIComponent(name)}&select=name,enabled&limit=1`;
  const rows = (await getJson(url, serviceRoleKey, deps)) as DepartmentRow[];
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** 注册资格校验主流程 */
export async function checkRegisterEligibility(
  supabaseUrl: string,
  serviceRoleKey: string,
  oaAccount: string,
  deps: CheckRegisterDeps = {}
): Promise<RegisterEligibility> {
  const staff = await findStaff(
    supabaseUrl,
    serviceRoleKey,
    oaAccount,
    deps
  );
  // 不在 staff_directory → 非内部人员
  if (!staff) {
    return { eligible: false, reason: 'not-staff' };
  }

  // 在 staff_directory → 检查部门 enabled
  const department = await findDepartment(
    supabaseUrl,
    serviceRoleKey,
    staff.department,
    deps
  );
  // 部门未在 departments 表登记：按"未开放"处理
  if (!department || !department.enabled) {
    return { eligible: false, reason: 'department-disabled' };
  }

  return { eligible: true };
}

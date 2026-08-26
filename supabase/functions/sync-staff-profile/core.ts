/**
 * sync-staff-profile Edge Function core logic (no Deno dependency, unit-testable)
 *
 * 注册成功后，根据 staff_directory 表的字段填写 user_profiles：
 * 1. 按 oa_account 查 staff_directory，取 department / region / position / name
 * 2. upsert user_profiles（department / region / position / oa_account）
 * 3. 更新 auth.users.user_metadata（full_name = staff.name 等），供前端显示中文名
 *
 * staff_directory 无 RLS 策略（anon 不可读），因此用 service_role 操作。
 */

export interface SyncStaffProfileDeps {
  /** 注入 HTTP 客户端便于测试；默认 global fetch */
  fetch?: typeof fetch;
}

export interface SyncStaffProfileEnv {
  SERVICE_ROLE_KEY: string;
  SUPABASE_URL: string;
}

interface StaffRow {
  department: string;
  region: string;
  position: string;
  name: string;
  oa_account: string;
}

interface SyncResult {
  synced: boolean;
  staff?: StaffRow;
}

async function requestJson(
  url: string,
  serviceRoleKey: string,
  options: { method?: string; body?: unknown } = {},
  deps: SyncStaffProfileDeps
): Promise<any> {
  const doFetch = deps.fetch || fetch;
  const response = await doFetch(url, {
    method: options.method || 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(
      `request failed: ${response.status} ${(payload?.message || text).slice(0, 200)}`
    );
  }
  return payload;
}

/** 按 oa_account 查 staff_directory */
async function findStaff(
  supabaseUrl: string,
  serviceRoleKey: string,
  oaAccount: string,
  deps: SyncStaffProfileDeps
): Promise<StaffRow | null> {
  const base = `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/staff_directory`;
  const url = `${base}?oa_account=eq.${encodeURIComponent(oaAccount)}&select=department,region,position,name,oa_account&limit=1`;
  const rows = (await requestJson(url, serviceRoleKey, {}, deps)) as StaffRow[];
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** 更新 auth.users.user_metadata（GoTrue admin API） */
async function updateUserMetadata(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  metadata: Record<string, string>,
  deps: SyncStaffProfileDeps
): Promise<void> {
  const base = `${(supabaseUrl || '').replace(/\/$/, '')}/auth/v1/admin`;
  await requestJson(
    `${base}/users/${userId}`,
    serviceRoleKey,
    { method: 'PUT', body: { user_metadata: metadata } },
    deps
  );
}

/** 同步主流程：根据 staff_directory 填写 user_profiles + user_metadata */
export async function syncStaffProfile(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  oaAccount: string,
  deps: SyncStaffProfileDeps = {}
): Promise<SyncResult> {
  const staff = await findStaff(supabaseUrl, serviceRoleKey, oaAccount, deps);
  if (!staff) {
    return { synced: false };
  }

  const profileFields = {
    department: staff.department,
    region: staff.region,
    position: staff.position,
    oa_account: staff.oa_account,
  };

  // upsert user_profiles（含 Prefer 头：冲突时合并）
  const doFetch = deps.fetch || fetch;
  const base = `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/user_profiles`;
  const upsertResponse = await doFetch(`${base}?on_conflict=user_id`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ user_id: userId, ...profileFields }),
  });
  if (!upsertResponse.ok) {
    throw new Error(
      `user_profiles upsert failed: ${upsertResponse.status} ${(await upsertResponse.text()).slice(0, 200)}`
    );
  }

  // 更新 user_metadata（full_name 供前端头像显示中文名）
  await updateUserMetadata(
    supabaseUrl,
    serviceRoleKey,
    userId,
    {
      full_name: staff.name,
      department: staff.department,
      region: staff.region,
      position: staff.position,
      oa_account: staff.oa_account,
    },
    deps
  );

  return { synced: true, staff };
}

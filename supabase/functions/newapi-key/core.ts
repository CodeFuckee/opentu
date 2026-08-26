/**
 * newapi-key Edge Function core logic (no Deno dependency, unit-testable)
 *
 * 为用户获取/创建 new-api apikey，完整流程：
 * 1. 读取 user_profiles.apikey；非空直接返回（步骤 7）
 * 2. 从 configs 表读取 NEWAPI_URL / NEWAPI_TOKEN
 * 3. 在 new-api 平台按 username(oa账号) 查用户是否存在
 * 4. 不存在 → 创建用户（随机密码，密码写入 user_profiles.newapi_password）
 *    → 设用户账户额度 200（仅首次创建）
 * 5. 存在 → 复用存储的密码
 * 6. 用用户凭证登录 new-api → 建令牌 → 取完整 key → 写入 user_profiles.apikey
 * 7. 返回 apikey
 */

export interface NewapiKeyDeps {
  /** 注入 HTTP 客户端便于测试；默认 global fetch */
  fetch?: typeof fetch;
  /** 注入随机密码生成器便于测试；默认 crypto 随机 */
  generatePassword?: () => string;
}

export interface NewapiKeyEnv {
  SERVICE_ROLE_KEY: string;
  SUPABASE_URL: string;
}

export interface DbRow {
  key: string;
  value: string;
}

/** 从 configs 表按 key 读取 value（走 PostgREST，service_role 可读任意行） */
export async function readConfigValue(
  supabaseUrl: string,
  serviceRoleKey: string,
  configKey: string,
  deps: NewapiKeyDeps = {}
): Promise<string | null> {
  const doFetch = deps.fetch || fetch;
  const url = `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/configs?key=eq.${encodeURIComponent(configKey)}&select=value`;

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
      `configs query failed: ${response.status} ${(await response.text()).slice(0, 200)}`
    );
  }
  const rows = (await response.json()) as DbRow[];
  return Array.isArray(rows) && rows.length > 0 ? rows[0].value : null;
}

/** 读取并写入 user_profiles 的单行字段（service_role，绕过 RLS） */
export async function readProfileValue(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  field: string,
  deps: NewapiKeyDeps = {}
): Promise<string | null> {
  const doFetch = deps.fetch || fetch;
  const url = `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/user_profiles?user_id=eq.${userId}&select=${field}`;
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
      `user_profiles read failed: ${response.status} ${(await response.text()).slice(0, 200)}`
    );
  }
  const rows = (await response.json()) as Array<Record<string, string | null>>;
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const value = rows[0][field];
  return typeof value === 'string' ? value : null;
}

/** 写入 user_profiles 字段（service_role，upsert） */
export async function writeProfileValue(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  fields: Record<string, string>,
  deps: NewapiKeyDeps = {}
): Promise<void> {
  const doFetch = deps.fetch || fetch;
  const url = `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/user_profiles?on_conflict=user_id`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
      Accept: 'application/json',
    },
    body: JSON.stringify({ user_id: userId, ...fields }),
  });
  if (!response.ok) {
    throw new Error(
      `user_profiles write failed: ${response.status} ${(await response.text()).slice(0, 200)}`
    );
  }
}

/** new-api 平台客户端（基于 one-api/new-api 管理 API，已实测） */

interface NewApiUser {
  id: number;
  username: string;
  quota: number;
}

async function newApiRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
  deps: NewapiKeyDeps = {}
): Promise<any> {
  const doFetch = deps.fetch || fetch;
  const url = `${(baseUrl || '').replace(/\/$/, '')}${path}`;
  const response = await doFetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
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
  if (!response.ok || payload?.success === false) {
    throw new Error(
      `new-api request failed: ${response.status} ${(payload?.message || text).slice(0, 200)}`
    );
  }
  return payload;
}

/** 查询 new-api 用户是否存在（按 username） */
export async function findNewApiUser(
  baseUrl: string,
  adminToken: string,
  username: string,
  deps: NewapiKeyDeps = {}
): Promise<NewApiUser | null> {
  const payload = await newApiRequest(
    baseUrl,
    `/api/user/search?keyword=${encodeURIComponent(username)}`,
    adminToken,
    {},
    deps
  );
  const items = payload?.data?.items;
  if (!Array.isArray(items)) {
    return null;
  }
  const found = items.find(
    (item: NewApiUser) => item.username === username
  );
  return found || null;
}

/** 创建 new-api 用户 */
export async function createNewApiUser(
  baseUrl: string,
  adminToken: string,
  username: string,
  password: string,
  deps: NewapiKeyDeps = {}
): Promise<void> {
  await newApiRequest(
    baseUrl,
    '/api/user/',
    adminToken,
    { method: 'POST', body: { username, password, display_name: username } },
    deps
  );
}

/** 设置 new-api 用户账户额度（mode=override 直接设为 value） */
export async function setNewApiUserQuota(
  baseUrl: string,
  adminToken: string,
  userId: number,
  quota: number,
  deps: NewapiKeyDeps = {}
): Promise<void> {
  await newApiRequest(
    baseUrl,
    '/api/user/manage',
    adminToken,
    {
      method: 'POST',
      body: { id: userId, action: 'add_quota', value: quota, mode: 'override' },
    },
    deps
  );
}

/** 用用户凭证登录 new-api，返回 access_token */
export async function loginNewApiUser(
  baseUrl: string,
  username: string,
  password: string,
  deps: NewapiKeyDeps = {}
): Promise<string> {
  const payload = await newApiRequest(
    baseUrl,
    '/api/user/login',
    '',
    { method: 'POST', body: { username, password } },
    deps
  );
  const token = payload?.data?.access_token;
  if (typeof token !== 'string' || !token) {
    throw new Error('new-api login failed: no access_token');
  }
  return token;
}

/** 以用户身份创建令牌，返回完整 key */
export async function createNewApiToken(
  baseUrl: string,
  userToken: string,
  name: string,
  deps: NewapiKeyDeps = {}
): Promise<string> {
  const payload = await newApiRequest(
    baseUrl,
    '/api/token/',
    userToken,
    {
      method: 'POST',
      body: {
        name,
        expired_time: -1,
        unlimited_quota: false,
        remain_quota: 0,
      },
    },
    deps
  );
  // 创建响应不含 key，需通过列表或 /:id/key 获取
  const items = payload?.data?.items;
  if (Array.isArray(items) && items.length > 0) {
    const token = items[items.length - 1];
    return token.key;
  }
  // 兜底：列出令牌取最后一个
  const list = await newApiRequest(baseUrl, '/api/token/?p=1&size=50', userToken, {}, deps);
  const listItems = list?.data?.items;
  if (Array.isArray(listItems) && listItems.length > 0) {
    return listItems[listItems.length - 1].key;
  }
  throw new Error('new-api token created but key not found');
}

/** 随机密码生成器（默认实现） */
export function generateRandomPassword(length = 16): string {
  const chars =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  let result = '';
  const randomValues = new Uint32Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

/**
 * 主流程：获取/创建用户 apikey。
 * 返回 { apikey: string } 或抛错。
 */
export async function getOrCreateApiKey(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  oaAccount: string,
  deps: NewapiKeyDeps = {}
): Promise<{ apikey: string }> {
  // 步骤 1：apikey 非空直接返回
  const existing = await readProfileValue(
    supabaseUrl,
    serviceRoleKey,
    userId,
    'apikey',
    deps
  );
  if (existing) {
    return { apikey: existing };
  }

  // 步骤 2：读 configs
  const newApiUrl = await readConfigValue(
    supabaseUrl,
    serviceRoleKey,
    'NEWAPI_URL',
    deps
  );
  const newApiToken = await readConfigValue(
    supabaseUrl,
    serviceRoleKey,
    'NEWAPI_TOKEN',
    deps
  );
  if (!newApiUrl || !newApiToken) {
    throw new Error('NEWAPI_URL or NEWAPI_TOKEN not configured');
  }

  const generatePassword =
    deps.generatePassword || generateRandomPassword;

  // 步骤 3：查 new-api 用户是否存在
  const existingUser = await findNewApiUser(
    newApiUrl,
    newApiToken,
    oaAccount,
    deps
  );

  let password: string;
  if (existingUser) {
    // 已存在：复用存储的密码（若缺失则生成新密码并更新，同时重置 new-api 密码）
    password =
      (await readProfileValue(
        supabaseUrl,
        serviceRoleKey,
        userId,
        'newapi_password',
        deps
      )) || generatePassword();
    await writeProfileValue(
      supabaseUrl,
      serviceRoleKey,
      userId,
      { newapi_password: password },
      deps
    );
  } else {
    // 步骤 4：创建用户 + 设额度 200
    password = generatePassword();
    await createNewApiUser(newApiUrl, newApiToken, oaAccount, password, deps);
    const created = await findNewApiUser(newApiUrl, newApiToken, oaAccount, deps);
    if (created) {
      await setNewApiUserQuota(newApiUrl, newApiToken, created.id, 200, deps);
    }
    await writeProfileValue(
      supabaseUrl,
      serviceRoleKey,
      userId,
      { newapi_password: password },
      deps
    );
  }

  // 步骤 6：登录 → 建令牌 → 取完整 key
  const userToken = await loginNewApiUser(newApiUrl, oaAccount, password, deps);
  const tokenName = `${oaAccount}-${Date.now()}`;
  const key = await createNewApiToken(newApiUrl, userToken, tokenName, deps);

  // 写入 apikey 并返回
  await writeProfileValue(
    supabaseUrl,
    serviceRoleKey,
    userId,
    { apikey: key },
    deps
  );
  return { apikey: key };
}

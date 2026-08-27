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

/**
 * 管理员权限同步已有用户的密码到 new-api 平台。
 * 平台上已存在同名用户时，本地生成的密码必须经此接口写入平台，
 * 否则用户登录永远报 "Username or password is incorrect"。
 */
export async function updateNewApiUserPassword(
  baseUrl: string,
  adminToken: string,
  userId: number,
  username: string,
  newPassword: string,
  deps: NewapiKeyDeps = {}
): Promise<void> {
  await newApiRequest(
    baseUrl,
    '/api/user/',
    adminToken,
    {
      method: 'PUT',
      body: { id: userId, username, password: newPassword },
    },
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

/** 以用户身份创建令牌，返回完整 key（含 sk- 前缀） */
export async function createNewApiToken(
  baseUrl: string,
  userToken: string,
  name: string,
  deps: NewapiKeyDeps = {}
): Promise<string> {
  // 创建响应不含 key/id，仅返回 success。
  // unlimited_quota 必须为 true：平台对 token 自身也做配额校验，
  // remain_quota:0 且非 unlimited 会产生"出生即耗尽"的无效令牌；
  // 额度管控由账户级配额（注册时 add_quota）与本代理的月度计量负责。
  await newApiRequest(
    baseUrl,
    '/api/token/',
    userToken,
    {
      method: 'POST',
      body: {
        name,
        expired_time: -1,
        unlimited_quota: true,
        remain_quota: 0,
      },
    },
    deps
  );

  // 平台对列表/详情接口统一打码 key（GetMaskedKey），
  // 完整 key 必须用唯一名称搜出 id 后经 POST /api/token/:id/key 获取。
  const searchPayload = await newApiRequest(
    baseUrl,
    `/api/token/search?keyword=${encodeURIComponent(name)}`,
    userToken,
    {},
    deps
  );
  const items = searchPayload?.data?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`new-api token created but not found by search: ${name}`);
  }
  const created = items.find((item: any) => item.name === name);
  if (!created || typeof created.id !== 'number') {
    throw new Error(`new-api token id not found for: ${name}`);
  }

  const keyPayload = await newApiRequest(
    baseUrl,
    `/api/token/${created.id}/key`,
    userToken,
    { method: 'POST' },
    deps
  );
  const fullKey = keyPayload?.data?.key;
  assertFullTokenKey(fullKey);

  // 与平台前端“复制”行为一致：携带 sk- 前缀存储与使用
  return `sk-${fullKey}`;
}

/**
 * 校验取到的是完整明文 key：平台对部分接口/旧版本会返回中间带 * 的掩码，
 * 一旦入库将导致上游 Invalid token，必须显式拒绝。
 */
export function assertFullTokenKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length < 32) {
    throw new Error('new-api returned invalid/truncated token key');
  }
  if (key.includes('*')) {
    throw new Error(
      'new-api returned a masked token key; upgrade platform or check token key endpoint'
    );
  }
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
    // 平台已存在：优先复用存储的密码；缺失则生成新密码并同步到平台
    // （此前缺陷：仅写库不同步平台，导致登录永败，见 core.test.ts 复现用例）
    const stored = await readProfileValue(
      supabaseUrl,
      serviceRoleKey,
      userId,
      'newapi_password',
      deps
    );
    password = stored || generatePassword();
    if (!stored) {
      await updateNewApiUserPassword(
        newApiUrl,
        newApiToken,
        existingUser.id,
        oaAccount,
        password,
        deps
      );
    }
    await writeProfileValue(
      supabaseUrl,
      serviceRoleKey,
      userId,
      { newapi_password: password },
      deps
    );
  } else {
    // 步骤 4：创建用户 + 设额度 200（创建时已带密码，无需再同步）
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
  let userToken: string;
  try {
    userToken = await loginNewApiUser(newApiUrl, oaAccount, password, deps);
  } catch (error) {
    // 库中残留与平台不一致的历史脏密码（旧版本遗留）→ 自愈：
    // 重新生成随机密码 → 管理员接口同步到平台 → 重试一次
    const message = (error as Error).message || '';
    if (!existingUser || !/password is incorrect|banned/i.test(message)) {
      throw error;
    }
    password = generatePassword();
    await updateNewApiUserPassword(
      newApiUrl,
      newApiToken,
      existingUser.id,
      oaAccount,
      password,
      deps
    );
    await writeProfileValue(
      supabaseUrl,
      serviceRoleKey,
      userId,
      { newapi_password: password },
      deps
    );
    userToken = await loginNewApiUser(newApiUrl, oaAccount, password, deps);
  }
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

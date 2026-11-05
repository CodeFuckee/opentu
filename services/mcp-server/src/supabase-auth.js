/**
 * Supabase 密码登录会话管理
 *
 * 语义对齐前端 apps/web/src/supabase/auth-context.tsx：
 * - signInWithPassword（POST /auth/v1/token?grant_type=password，apikey=anon key）
 * - access_token 到期前 leeway（默认 30s）自动用 refresh_token 刷新
 * - 刷新失败（密码被改/refresh 失效）自动降级重登
 * - invalidate() 供 ai-proxy 401 时强制重登
 */

export class SupabaseAuthError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'SupabaseAuthError';
    this.status = status;
    this.body = body;
  }
}

export function createSupabaseAuth({
  supabaseUrl,
  anonKey,
  email,
  password,
  fetchImpl = globalThis.fetch,
  leewayMs = 30000,
  nowFn = Date.now,
  logger = console,
}) {
  /** @type {{accessToken,refreshToken,userId,userEmail,expiresAt}|null} */
  let session = null;
  let refreshPromise = null;

  // 快速失败：凭据缺失时启动即报错，而不是等运行期登录 401 才暴露
  for (const [key, value] of [
    ['supabaseUrl', supabaseUrl],
    ['anonKey', anonKey],
    ['email', email],
    ['password', password],
  ]) {
    if (!value) {
      throw new SupabaseAuthError(`createSupabaseAuth 缺少参数: ${key}`);
    }
  }

  async function requestToken(grant, body) {
    let res;
    try {
      res = await fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new SupabaseAuthError(
        `supabase 认证服务不可达: ${error?.message || error}`
      );
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 非 JSON 响应按错误处理
    }
    if (!res.ok) {
      const message =
        json?.error_description || json?.msg || json?.error || `HTTP ${res.status}`;
      throw new SupabaseAuthError(`supabase 登录/刷新失败: ${message}`, {
        status: res.status,
        body: json,
      });
    }
    return json;
  }

  function applySession(json) {
    session = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      userId: json.user?.id ?? null,
      userEmail: json.user?.email ?? email,
      expiresAt: nowFn() + (Number(json.expires_in) || 3600) * 1000,
    };
    return session;
  }

  async function signIn() {
    return applySession(await requestToken('password', { email, password }));
  }

  async function refresh() {
    if (!session?.refreshToken) return signIn();
    try {
      return applySession(
        await requestToken('refresh_token', { refresh_token: session.refreshToken })
      );
    } catch (error) {
      logger.warn?.(
        '[auth] refresh 失败，降级重登:',
        error?.message || error
      );
      return signIn();
    }
  }

  /** 获取可用 access_token；过期（含提前量）时刷新/登录，并发调用合并为一次 */
  async function getAccessToken() {
    if (session && nowFn() < session.expiresAt - leewayMs) {
      return session.accessToken;
    }
    if (!refreshPromise) {
      const task = session?.refreshToken ? refresh() : signIn();
      refreshPromise = task.finally(() => {
        refreshPromise = null;
      });
    }
    const next = await refreshPromise;
    return next.accessToken;
  }

  /** 强制失效（ai-proxy 401 时调用），下次取 token 重登 */
  function invalidate() {
    session = null;
  }

  /** 当前登录用户（需先有一次成功 getAccessToken/signIn） */
  function getUser() {
    if (!session) return null;
    return { id: session.userId, email: session.userEmail };
  }

  return { getAccessToken, invalidate, getUser };
}

/**
 * Edge Function: feedbackland-sso (core)
 *
 * 为 opentu → Feedbackland 的免登跳转颁发一次性 magic link token：
 *   1. 校验调用者 Bearer JWT（必须为 opentu 已登录用户）；
 *   2. 从 JWT 对应用户取 email；
 *   3. 以 service role 调 GoTrue admin generate_link（type=magiclink），
 *      生成一次性、短时效的 token（用后即焚，泄露无害）；
 *   4. 返回 { token_hash }，由 Feedbackland 侧回调页 verifyOtp 换正式会话。
 *
 * 安全属性：长期凭据（密码/refresh_token）永不跨域；一次性 token 不含任何
 * 敏感信息，仅能使用一次且几分钟内过期。email 取自 JWT 本身而非请求体，
 * 调用者无法为他人换取登录凭据。
 *
 * 请求：POST /functions/v1/feedbackland-sso，Authorization: Bearer <用户 JWT>
 * 响应：200 { token_hash } / 401 / 400 / 404 / 502 { error }
 */

/** CORS 头（opentu 侧中转页跨域调用；自托管内网环境，来源放开） */
export const FEEDBACK_SSO_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};

export interface FeedbackSsoDeps {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** 可注入 fetch（单测）；缺省用全局 fetch */
  fetch?: typeof fetch;
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || null : null;
}

/** 从 generate_link 返回的 action_link 中解析一次性 token（兜底路径） */
export function extractTokenHashFromActionLink(actionLink: string): string | null {
  try {
    return new URL(actionLink).searchParams.get('token');
  } catch {
    return null;
  }
}

function jsonResponse(
  status: number,
  body: unknown,
  cors = true
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(cors ? FEEDBACK_SSO_CORS_HEADERS : {}),
    },
  });
}

interface GoTrueUser {
  email?: string | null;
}

interface GoTrueGenerateLinkResponse {
  action_link?: string;
  hashed_token?: string;
  message?: string;
  error?: string;
  msg?: string;
}

/**
 * 处理 SSO 换取请求。deps.fetch 可注入以便单测。
 */
export async function handleFeedbackSsoRequest(
  request: Request,
  deps: FeedbackSsoDeps
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: { ...FEEDBACK_SSO_CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
    });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method not allowed' });
  }

  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    return jsonResponse(401, { error: 'missing bearer token' });
  }

  // 1. 校验调用者 JWT 并取用户（GET /auth/v1/user 以 Bearer 自证身份）
  let user: GoTrueUser;
  try {
    const userResponse = await doFetch(`${deps.supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: deps.serviceRoleKey,
      },
    });
    if (!userResponse.ok) {
      return jsonResponse(401, { error: 'invalid or expired token' });
    }
    user = (await userResponse.json()) as GoTrueUser;
  } catch (error) {
    return jsonResponse(502, {
      error: `auth verify failed: ${error instanceof Error ? error.message : 'unknown'}`,
    });
  }

  const email = user.email?.trim();
  if (!email) {
    return jsonResponse(400, { error: 'user has no email' });
  }

  // 2. 以 service role 为该 email 生成一次性 magic link（用户必然已存在于
  //    Supabase auth——能通过第 1 步即证明），hashed_token 供 verifyOtp 使用
  let linkResponse: Response;
  try {
    linkResponse = await doFetch(
      `${deps.supabaseUrl}/auth/v1/admin/generate_link`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deps.serviceRoleKey}`,
          apikey: deps.serviceRoleKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'magiclink', email }),
      }
    );
  } catch (error) {
    return jsonResponse(502, {
      error: `generate link failed: ${error instanceof Error ? error.message : 'unknown'}`,
    });
  }

  if (!linkResponse.ok) {
    const raw = await linkResponse.text().catch(() => '');
    let message = raw.slice(0, 200) || `HTTP ${linkResponse.status}`;
    try {
      const parsed = JSON.parse(raw) as GoTrueGenerateLinkResponse;
      message = parsed.message || parsed.error || parsed.msg || message;
    } catch {
      // 非 JSON 响应，沿用原文
    }
    return jsonResponse(
      linkResponse.status === 404 ? 404 : 502,
      { error: `generate link failed: ${message}` }
    );
  }

  const linkBody = (await linkResponse.json()) as GoTrueGenerateLinkResponse;
  const tokenHash =
    linkBody.hashed_token ||
    (linkBody.action_link ? extractTokenHashFromActionLink(linkBody.action_link) : null);

  if (!tokenHash) {
    return jsonResponse(502, { error: 'generate link returned no token' });
  }

  return jsonResponse(200, { token_hash: tokenHash });
}

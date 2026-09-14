/**
 * Edge Function: ai-proxy core logic (no Deno dependency, unit-testable)
 *
 * 生图额度管控代理：
 * 1. 校验调用者 Supabase JWT（GET /auth/v1/user），得到可信 user_id
 * 2. 服务端分类请求是否为"图像提交"并原子扣减当月额度（consume_image_quota）
 * 3. 用 configs.NEWAPI_KEY 注入上游鉴权头，将请求原样转发到 configs.NEWAPI_URL
 * 4. 上游 ≥400 立即退回；异步任务轮询到终态失败时一次性退回
 * 5. GET .../quota 返回剩余额度（get_image_quota）
 *
 * 计费规则（服务端路径/内容判定为准）：
 * - POST …/images/generations、…/images/edits：同步生图，按 body.n 扣减（默认1，上限10）
 * - POST …mj/submit…：MJ 提交，按 1 扣减，成功后记账，终态失败退回
 * - POST …/videos（异步媒体提交）：按模型名判定；命中配置的异步图像模型模式才扣减
 * - Google 协议 :generateContent/:streamGenerateContent 且 responseModalities 含 IMAGE：按 1 扣减
 * - 其余（文本/音频/视频等）：透传不计费
 *
 * 响应归档已移至前端（providerTransport 在拿到上游响应时 fire-and-forget 转存
 * huabu bucket + 写 task_submissions.upstream_response）：edge 函数内不再 await
 * 大型归档，避免长时间占用 worker 触发 supervisor 取消（500 WorkerRequestCancelled）。
 */

export interface AiProxyDeps {
  /** 注入 HTTP 客户端便于测试；默认 global fetch */
  fetch?: typeof fetch;
}

export interface AiProxyEnv {
  SUPABASE_URL: string;
  SERVICE_ROLE_KEY: string;
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-ai-billing',
};

/** 从响应中透传给客户端的头 */
const RESPONSE_PASSTHROUGH_HEADERS = [
  'content-type',
  'cache-control',
  'retry-after',
];

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

// ============================================================
// Supabase 基础设施访问（与 newapi-key 保持同构，函数目录独立部署）
// ============================================================

export async function verifyUserJwt(
  env: AiProxyEnv,
  jwt: string,
  deps: AiProxyDeps = {}
): Promise<{ id: string; email: string | null } | null> {
  const doFetch = deps.fetch || fetch;
  const url = `${(env.SUPABASE_URL || '').replace(/\/$/, '')}/auth/v1/user`;
  const response = await doFetch(url, {
    method: 'GET',
    headers: {
      apikey: env.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${jwt}`,
    },
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as {
    id?: unknown;
    email?: unknown;
  };
  if (typeof payload?.id !== 'string') {
    return null;
  }
  return {
    id: payload.id,
    email: typeof payload.email === 'string' ? payload.email : null,
  };
}

async function readConfigValue(
  env: AiProxyEnv,
  configKey: string,
  deps: AiProxyDeps = {}
): Promise<string | null> {
  const doFetch = deps.fetch || fetch;
  const url = `${(env.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1/configs?key=eq.${encodeURIComponent(configKey)}&select=value`;
  const response = await doFetch(url, {
    method: 'GET',
    headers: {
      apikey: env.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`configs query failed: ${response.status}`);
  }
  const rows = (await response.json()) as Array<{ value: string }>;
  return Array.isArray(rows) && rows.length > 0 ? rows[0].value : null;
}

async function callProfileRpc(
  env: AiProxyEnv,
  fnName: string,
  args: Record<string, unknown>,
  deps: AiProxyDeps = {}
): Promise<Record<string, unknown> | null> {
  const doFetch = deps.fetch || fetch;
  const url = `${(env.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1/rpc/${fnName}`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      apikey: env.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(
      `rpc ${fnName} failed: ${response.status} ${(await response.text()).slice(0, 200)}`
    );
  }
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  const payload = JSON.parse(text);
  return payload === null ? null : (payload as Record<string, unknown>);
}

async function callVoidRpc(
  env: AiProxyEnv,
  fnName: string,
  args: Record<string, unknown>,
  deps: AiProxyDeps = {}
): Promise<void> {
  await callProfileRpc(env, fnName, args, deps);
}

/**
 * 获取上游 AI 网关的 apikey。
 *
 * 直接使用 configs 表中的 NEWAPI_KEY（全局共享的网关密钥），
 * 不再走 user_profiles.apikey / newapi-key 每用户铸造流程。
 */
export async function ensureUserApiKey(
  env: AiProxyEnv,
  _userId: string,
  deps: AiProxyDeps = {}
): Promise<string | null> {
  return readConfigValue(env, 'NEWAPI_KEY', deps);
}

// ============================================================
// 计费分类
// ============================================================

export interface RequestClassification {
  /** 是否需要在转发前扣减额度 */
  billable: boolean;
  /** 同步类（失败立即退回）还是异步提交类（成功后记账） */
  mode: 'none' | 'sync' | 'submit';
  count: number;
  /** 异步图像模型的表单/JSON 里读到的模型名（调试用） */
  detectedModel?: string;
}

/** 判断 URL 路径是否为轮询型端点（用于检测终态失败并退回） */
export function isPollingPath(path: string): boolean {
  return /\/videos\/[^/]+(\?|$)|\/mj\/task\/[^/]+\/fetch(\?|$)|\/mj\/task\/[^/]+(\?|$)/.test(
    path
  );
}

function clampImageCount(n: unknown): number {
  const parsed =
    typeof n === 'number' ? n : typeof n === 'string' ? parseInt(n, 10) : NaN;
  if (Number.isFinite(parsed)) {
    return Math.min(Math.max(Math.floor(parsed), 1), 10);
  }
  return 1;
}

function extractModelFromText(text: string): string | undefined {
  try {
    const json = JSON.parse(text) as { model?: unknown };
    if (typeof json?.model === 'string') {
      return json.model;
    }
  } catch {
    // 非 JSON：尝试 multipart 表单里的 model 字段
    const match = text.match(/name="model"\r?\n\r?\n([^\r\n&\s"]+)/);
    if (match) {
      return match[1];
    }
    const queryLike = text.match(/(^|&)model=([^&]+)/);
    if (queryLike) {
      return decodeURIComponent(queryLike[2]);
    }
  }
  return undefined;
}

/**
 * 对将要转发的请求做计费分类。
 * asyncPattern 来自 configs 的 ASYNC_IMAGE_MODEL_PATTERN（缺省 'image'），
 * 用于区分"异步图像表单提交"和"视频/音频任务提交"。
 */
export function classifyBilling(
  method: string,
  path: string,
  bodyText: string | null,
  asyncImageModelPattern: string = 'image'
): RequestClassification {
  const lowerPath = path.toLowerCase();

  if (method === 'POST' && /\/images\/generations$/.test(lowerPath)) {
    const count = clampImageCount(safeParseJson(bodyText)?.n);
    return { billable: true, mode: 'sync', count };
  }
  if (method === 'POST' && /\/images\/edits$/.test(lowerPath)) {
    // 图片编辑同样产出一张图（multipart 中 n 字段不易取，近似 1 张）
    return { billable: true, mode: 'sync', count: 1 };
  }
  if (method === 'POST' && lowerPath.includes('/mj/submit')) {
    return { billable: true, mode: 'submit', count: 1 };
  }

  // 异步媒体提交（openai.async.media 表单走 /v1/videos）
  if (method === 'POST' && /\/videos\/?$/.test(lowerPath)) {
    const model = bodyText ? extractModelFromText(bodyText) : undefined;
    let pattern = asyncImageModelPattern || 'image';
    try {
      pattern = new RegExp(pattern, 'i').source;
    } catch {
      pattern = 'image';
    }
    if (model && new RegExp(pattern, 'i').test(model)) {
      return { billable: true, mode: 'submit', count: 1, detectedModel: model };
    }
    return { billable: false, mode: 'none', count: 0 };
  }

  // Google 协议：body 声明图像模态才算图
  if (
    method === 'POST' &&
    (lowerPath.includes(':streamgeneratecontent') ||
      lowerPath.includes(':generatecontent'))
  ) {
    const json = safeParseJson(bodyText) as {
      generationConfig?: { responseModalities?: unknown };
    };
    const modalities = json?.generationConfig?.responseModalities;
    if (
      Array.isArray(modalities) &&
      modalities.some((m) => String(m).toUpperCase() === 'IMAGE')
    ) {
      return { billable: true, mode: 'sync', count: 1 };
    }
  }

  return { billable: false, mode: 'none', count: 0 };
}

function safeParseJson(text: string | null): any {
  if (!text || !text.trim().startsWith('{')) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从响应体 JSON 或轮询路径中提取上游任务 id */
export function extractUpstreamId(path: string, bodyJson: any): string | null {
  const candidates = [
    bodyJson?.id,
    bodyJson?.taskId,
    bodyJson?.task_id,
    bodyJson?.uid,
    bodyJson?.data?.id,
    bodyJson?.data?.task_id,
    bodyJson?.data?.taskId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) {
      return candidate;
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  // 兜底：从路径尾部截取（/videos/{id} 或 /mj/task/{id}/fetch）
  const pathMatch = path.match(/\/(?:videos|task)\/([^/?]+)/i);
  return pathMatch ? pathMatch[1] : null;
}

const TERMINAL_FAILURE_STATUSES = /^(failed|cancelled|canceled|expired)$/;

/** 终态失败检测（用于异步任务一次性退回） */
export function detectTerminalFailure(bodyJson: any): boolean {
  if (!bodyJson || typeof bodyJson !== 'object') {
    return false;
  }
  const sources = [bodyJson, bodyJson?.data];
  for (const source of sources) {
    const status = source?.status ?? source?.state ?? source?.progress;
    if (typeof status === 'string' && TERMINAL_FAILURE_STATUSES.test(status.toLowerCase())) {
      return true;
    }
    // MJ 风格：{ code:..., status: "FAILURE"/"CANCELED" }
    if (typeof status === 'string' && /fail/i.test(status)) {
      return true;
    }
  }
  return false;
}

// ============================================================
// 主流程
// ============================================================

interface HandleArgs {
  env: AiProxyEnv;
  request: Request;
  /** 已剥离 /functions/v1/ai-proxy 前缀后的路径，如 "/v1/images/generations"、"/quota" */
  pathSuffix: string;
  deps?: AiProxyDeps;
}

export async function handleAiProxyRequest({
  env,
  request,
  pathSuffix,
  deps = {},
}: HandleArgs): Promise<Response> {
  const doFetch = deps.fetch || fetch;
  const supabaseBase = (env.SUPABASE_URL || '').replace(/\/$/, '');

  if (!supabaseBase || !env.SERVICE_ROLE_KEY) {
    return jsonResponse(500, { error: 'SUPABASE_URL / SERVICE_ROLE_KEY not configured' });
  }

  // ---------- 配额查询端点 ----------
  if (pathSuffix === '/quota' || pathSuffix === 'quota') {
    return handleQuotaQuery({ env, request, deps });
  }

  // ---------- 身份校验 ----------
  const jwt = extractBearerToken(request.headers.get('Authorization'));
  if (!jwt) {
    return jsonResponse(401, { error: 'unauthorized: missing bearer token' });
  }

  let identity: { id: string; email: string | null } | null = null;
  try {
    identity = await verifyUserJwt(env, jwt, deps);
  } catch {
    return jsonResponse(503, { error: 'auth service unavailable' });
  }
  if (!identity) {
    return jsonResponse(401, { error: 'unauthorized: invalid token' });
  }
  const userId = identity.id;

  const method = request.method.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return jsonResponse(405, { error: 'method not allowed' });
  }

  // ---------- 读上游与密钥配置 ----------
  let upstreamBaseUrl: string;
  let asyncImagePattern = 'image';
  try {
    const configured = await readConfigValue(env, 'NEWAPI_URL', deps);
    if (!configured) {
      return jsonResponse(503, { error: 'NEWAPI_URL not configured' });
    }
    upstreamBaseUrl = configured.replace(/\/$/, '');
    const pattern = await readConfigValue(env, 'ASYNC_IMAGE_MODEL_PATTERN', deps);
    if (pattern) {
      asyncImagePattern = pattern;
    }
  } catch (error) {
    console.warn('[ai-proxy] config unavailable:',
      error instanceof Error ? error.message : error);
    return jsonResponse(503, { error: 'config unavailable' });
  }

  let apiKey: string | null = null;
  try {
    apiKey = await ensureUserApiKey(env, userId, deps);
  } catch (error) {
    console.warn('[ai-proxy] upstream key unavailable:',
      error instanceof Error ? error.message : error);
    return jsonResponse(503, { error: 'upstream key unavailable' });
  }
  if (!apiKey) {
    return jsonResponse(503, { error: 'upstream key unavailable: profile has no apikey' });
  }

  // ---------- 构造上游请求 ----------
  const searchIndex = pathSuffix.indexOf('?');
  const pathOnly = searchIndex >= 0 ? pathSuffix.slice(0, searchIndex) : pathSuffix;
  const query = searchIndex >= 0 ? pathSuffix.slice(searchIndex) : '';

  let upstreamHeadersInit: HeadersInit = {};
  const incomingContentType = request.headers.get('content-type');
  if (incomingContentType) {
    upstreamHeadersInit = { 'Content-Type': incomingContentType };
  }

  const acceptHeader = request.headers.get('accept');
  if (acceptHeader) {
    upstreamHeadersInit = { ...upstreamHeadersInit, Accept: acceptHeader };
  }
  (upstreamHeadersInit as Record<string, string>)['Authorization'] =
    `Bearer ${apiKey}`;

  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await request.arrayBuffer();
  }

  // 小体积请求体做计费分类（大体积流式请求只在白名单路径下计费）
  const billingBodyText =
    body && body.byteLength <= 32 * 1024 * 1024
      ? new TextDecoder().decode(new Uint8Array(body))
      : null;
  const classification = classifyBilling(
    method,
    pathOnly,
    billingBodyText,
    asyncImagePattern
  );

  // ---------- 预扣额度 ----------
  if (classification.billable) {
    try {
      const outcome = await callProfileRpc(
        env,
        'consume_image_quota',
        { p_user_id: userId, p_count: classification.count },
        deps
      );
      if (!outcome || outcome.consumed !== true) {
        const remaining = Number(outcome?.remaining ?? 0);
        return jsonResponse(403, {
          error: 'quota_exceeded',
          message: '本月图片生成额度已用完',
          remaining,
        });
      }
    } catch (error) {
      console.warn('[ai-proxy] quota service error:',
        error instanceof Error ? error.message : error);
      return jsonResponse(503, { error: 'quota service error' });
    }
  }

  // 同步图片生成：把转发 body 的 n 收敛到与计费一致的上限，
  // 避免“按 10 张计费、上游实际产出 n>10 张”的脱钩
  if (
    classification.billable &&
    classification.mode === 'sync' &&
    /\/images\/generations$/.test(pathOnly.toLowerCase()) &&
    body
  ) {
    try {
      const parsed = JSON.parse(
        new TextDecoder().decode(new Uint8Array(body))
      ) as { n?: unknown };
      const clamped = clampImageCount(parsed.n);
      if (parsed.n !== undefined && parsed.n !== clamped) {
        parsed.n = clamped;
        body = new TextEncoder().encode(JSON.stringify(parsed))
          .buffer as ArrayBuffer;
      }
    } catch {
      // 非 JSON body 保持原样
    }
  }

  // ---------- 转发 ----------
  const upstreamUrl = `${upstreamBaseUrl}${pathOnly}${query}`;
  let upstreamResponse: Response;
  try {
    upstreamResponse = await doFetch(upstreamUrl, {
      method,
      headers: upstreamHeadersInit,
      body,
      signal: request.signal,
    });
  } catch {
    if (classification.billable) {
      await safeRefund(env, userId, classification.count, deps);
    }
    return jsonResponse(502, { error: 'upstream request failed' });
  }

  if (classification.billable && upstreamResponse.status >= 400) {
    await safeRefund(env, userId, classification.count, deps);
  }

  let respondBuffered = false;

  // ---------- 异步任务提交成功：记账；提交即终态失败也标记（前端终态轮询负责归档） ----------
  // 说明：响应归档（base64 转存 huabu bucket + 写 task_submissions.upstream_response）
  // 已移到前端 providerTransport（拿响应 clone 后 fire-and-forget），edge 函数不参与，
  // 避免在请求生命周期内 await 大型上传拖爆 worker（500 WorkerRequestCancelled）。
  if (!respondBuffered && classification.mode === 'submit' && upstreamResponse.ok) {
    try {
      const buffer = await consumeResponseText(upstreamResponse);
      const json = tryParseJson(buffer.text);
      const id = extractUpstreamId(pathOnly, json);
      if (id) {
        await callVoidRpc(
          env,
          'record_task_bill',
          { p_user_id: userId, p_upstream_id: id, p_count: classification.count || 1 },
          deps
        );
      }
      upstreamResponse = rebuildResponse(buffer);
      respondBuffered = true;
    } catch (error) {
      // 记账失败不影响主流程，但需重试一次并告警：
      // 账单行缺失会导致后续终态失败时无据可退（用户预扣额度无法退回）
      console.warn('[ai-proxy] record_task_bill failed:',
        error instanceof Error ? error.message : error);
      try {
        const retryBuffer = await consumeResponseText(upstreamResponse.clone());
        const retryJson = tryParseJson(retryBuffer.text);
        const retryId = extractUpstreamId(pathOnly, retryJson);
        if (retryId) {
          await callVoidRpc(
            env,
            'record_task_bill',
            { p_user_id: userId, p_upstream_id: retryId, p_count: classification.count || 1 },
            deps
          );
        }
      } catch (retryError) {
        console.warn('[ai-proxy] record_task_bill retry failed:',
          retryError instanceof Error ? retryError.message : retryError);
      }
    }
  }

  // ---------- 轮询响应：终态失败时一次性退回（成功后端不再归档，由前端终态轮询归档） ----------
  if (
    !respondBuffered &&
    !classification.billable &&
    method === 'GET' &&
    isPollingPath(pathOnly) &&
    upstreamResponse.ok
  ) {
    try {
      const buffer = await consumeResponseText(upstreamResponse);
      const json = tryParseJson(buffer.text);
      if (json && detectTerminalFailure(json)) {
        const id = extractUpstreamId(pathOnly, json);
        if (id) {
          await callVoidRpc(env, 'refund_task_bill', { p_upstream_id: id }, deps);
        }
      }
      upstreamResponse = rebuildResponse(buffer);
      respondBuffered = true;
    } catch {
      // 检测失败不影响透传
    }
  }

  return respondBuffered
    ? upstreamResponse
    : filterResponseHeaders(upstreamResponse);
}

async function handleQuotaQuery({
  env,
  request,
  deps,
}: Omit<HandleArgs, 'pathSuffix'>): Promise<Response> {
  const jwt = extractBearerToken(request.headers.get('Authorization'));
  if (!jwt) {
    return jsonResponse(401, { error: 'unauthorized: missing bearer token' });
  }
  const identity = await verifyUserJwt(env, jwt, deps).catch(() => null);
  if (!identity) {
    return jsonResponse(401, { error: 'unauthorized: invalid token' });
  }
  const userId = identity.id;
  try {
    const quota = await callProfileRpc(
      env,
      'get_image_quota',
      { p_user_id: userId },
      deps
    );
    return jsonResponse(200, { quota });
  } catch (error) {
    console.warn('[ai-proxy] quota service error:',
      error instanceof Error ? error.message : error);
    return jsonResponse(503, { error: 'quota service error' });
  }
}

async function safeRefund(
  env: AiProxyEnv,
  userId: string,
  count: number,
  deps: AiProxyDeps
): Promise<void> {
  try {
    await callVoidRpc(
      env,
      'refund_image_quota',
      { p_user_id: userId, p_count: count },
      deps
    );
  } catch {
    // 退回失败不打断响应，可由管理员补账
  }
}

export function extractBearerToken(headerValue: string | null): string | null {
  if (!headerValue) {
    return null;
  }
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

interface ConsumedBody {
  text: string;
  contentType: string;
  status: number;
  statusText: string;
}

/** 读出响应全文（轮询/提交响应均为小体积 JSON；供检查后重建响应） */
async function consumeResponseText(response: Response): Promise<ConsumedBody> {
  return {
    text: await response.text(),
    contentType:
      response.headers.get('content-type') || 'application/json',
    status: response.status,
    statusText: response.statusText,
  };
}

function tryParseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function rebuildResponse(buffer: ConsumedBody): Response {
  const headers = passThroughHeadersFrom(
    new Headers({ 'Content-Type': buffer.contentType })
  );
  return new Response(buffer.text, {
    status: buffer.status,
    statusText: buffer.statusText,
    headers,
  });
}

/** 以过滤后的头重建上游响应（避免透传 content-encoding 等冲突头） */
function filterResponseHeaders(response: Response): Response {
  const filtered = passThroughHeadersFrom(response.headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: filtered,
  });
}

function passThroughHeadersFrom(headers: Headers): Headers {
  const filtered = new Headers();
  headers.forEach((value, key) => {
    if (RESPONSE_PASSTHROUGH_HEADERS.includes(key.toLowerCase())) {
      filtered.set(key, value);
    }
  });
  filtered.set('Access-Control-Allow-Origin', '*');
  return filtered;
}

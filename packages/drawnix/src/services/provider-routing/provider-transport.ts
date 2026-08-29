import type {
  PreparedProviderTransportRequest,
  ProviderBaseUrlStrategy,
  ProviderTransportRequest,
  ResolvedProviderContext,
} from './types';
import {
  getManagedProxyBase,
  getManagedRoutingConfig,
  ImageQuotaExceededError,
  isManagedUpstreamEnabled,
  parseQuotaErrorFromResponse,
} from '../managed-routing/managed-runtime';
import { archiveUpstreamResponseFromFetch } from '../task-supabase-archive/service';

/** 托管模式下从请求头中剔除的本地凭据键（改由代理注入） */
const MANAGED_STRIPPED_HEADER_KEYS = ['authorization', 'x-api-key', 'x-goog-api-key'];

function stripManagedAuthHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!MANAGED_STRIPPED_HEADER_KEYS.includes(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 托管路由改写：将已解析出的上游 URL 隧道至 ai-proxy 边缘函数。
 * 仅保留 pathname+search（保留 baseUrlStrategy/join 后的真实上游路径语义），
 * 由服务端注入 API Key 并按路径规则计量生图额度。
 */
async function resolveManagedSendContext(
  context: ResolvedProviderContext
): Promise<{ context: ResolvedProviderContext; proxyBase: string; token: string } | null> {
  if (!isManagedUpstreamEnabled()) {
    return null;
  }
  const config = getManagedRoutingConfig();
  const proxyBase = getManagedProxyBase();
  if (!config || !proxyBase) {
    return null;
  }
  const token = await config.getToken();
  if (!token) {
    throw new Error('登录状态已失效，请重新登录后再使用 AI 功能');
  }

  // 清空本地凭据与鉴权头，避免把浏览器残留 key 带往任何方向
  const sanitized: ResolvedProviderContext = {
    ...context,
    apiKey: '',
    extraHeaders: context.extraHeaders
      ? stripManagedAuthHeaders(context.extraHeaders)
      : context.extraHeaders,
  };

  return { context: sanitized, proxyBase, token };
}

function rewriteUrlToProxy(
  prepared: PreparedProviderTransportRequest,
  proxyBase: string,
  token: string
): PreparedProviderTransportRequest {
  let targetPath = '';
  try {
    const parsed = new URL(prepared.url);
    targetPath = `${parsed.pathname}${parsed.search}`;
  } catch {
    targetPath = '';
  }
  if (!targetPath) {
    throw new Error('托管路由改写失败：无法解析上游地址');
  }

  const authedHeaders = {
    ...prepared.headers,
    Authorization: `Bearer ${token}`,
  };

  return {
    url: `${proxyBase}${targetPath}`,
    headers: authedHeaders,
    init: {
      ...prepared.init,
      headers: authedHeaders,
      credentials: 'omit',
    },
  };
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function applyBaseUrlStrategy(
  baseUrl: string,
  strategy: ProviderBaseUrlStrategy = 'preserve'
): string {
  const normalizedBaseUrl = trimTrailingSlashes(baseUrl);

  switch (strategy) {
    case 'trim-v1':
      return normalizedBaseUrl.replace(/\/v1$/i, '');
    case 'preserve':
    default:
      return normalizedBaseUrl;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const normalizedBase = trimTrailingSlashes(baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function buildQueryString(
  query?: Record<string, string | number | boolean | null | undefined>
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || key.trim() === '') {
      continue;
    }
    params.set(key, String(value));
  }

  const result = params.toString();
  return result ? `?${result}` : '';
}

function mergeHeaders(
  baseHeaders?: Record<string, string>,
  overrideHeaders?: Record<string, string>
): Record<string, string> {
  return {
    ...(baseHeaders || {}),
    ...(overrideHeaders || {}),
  };
}

function applyAuthHeaders(
  context: ResolvedProviderContext,
  headers: Record<string, string>
): Record<string, string> {
  if (!context.apiKey) {
    return headers;
  }

  switch (context.authType) {
    case 'bearer':
      return { ...headers, Authorization: `Bearer ${context.apiKey}` };
    case 'header':
      if (
        headers.Authorization ||
        headers.authorization ||
        headers['X-API-Key'] ||
        headers['x-api-key']
      ) {
        return headers;
      }
      return { ...headers, 'X-API-Key': context.apiKey };
    case 'custom':
    case 'query':
    default:
      return headers;
  }
}

function applyAuthQuery(
  context: ResolvedProviderContext,
  query: Record<string, string | number | boolean | null | undefined>
): Record<string, string | number | boolean | null | undefined> {
  if (!context.apiKey || context.authType !== 'query') {
    return query;
  }

  if (query.api_key !== undefined || query.key !== undefined) {
    return query;
  }

  const authQueryKey =
    context.providerType === 'gemini-compatible' ? 'key' : 'api_key';

  return {
    ...query,
    [authQueryKey]: context.apiKey,
  };
}

function createTimeoutSignal(
  upstreamSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): {
  signal: AbortSignal | undefined;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      signal: upstreamSignal,
      didTimeout: () => false,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  let didTimeout = false;

  const abortFromUpstream = () => {
    controller.abort(upstreamSignal?.reason);
  };

  if (upstreamSignal?.aborted) {
    controller.abort(upstreamSignal.reason);
  } else if (upstreamSignal) {
    upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
  }

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    const error = new Error(`Request timeout after ${timeoutMs}ms`);
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => didTimeout,
    cleanup: () => {
      clearTimeout(timeoutId);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    },
  };
}

export class ProviderTransport {
  prepareRequest(
    context: ResolvedProviderContext,
    request: ProviderTransportRequest
  ): PreparedProviderTransportRequest {
    const mergedHeaders = mergeHeaders(context.extraHeaders, request.headers);
    const authenticatedHeaders = applyAuthHeaders(context, mergedHeaders);
    // task_id 契约：携带 taskId 时附加 x-task-id 头（托管/直连均带，直连无副作用）
    if (request.taskId) {
      authenticatedHeaders['x-task-id'] = request.taskId;
    }
    const query = applyAuthQuery(context, request.query || {});
    const resolvedBaseUrl = applyBaseUrlStrategy(
      context.baseUrl,
      request.baseUrlStrategy
    );
    const url = `${joinUrl(resolvedBaseUrl, request.path)}${buildQueryString(
      query
    )}`;

    return {
      url,
      headers: authenticatedHeaders,
      init: {
        method: request.method || 'GET',
        headers: authenticatedHeaders,
        body: request.body,
        signal: request.signal,
        credentials: request.credentials,
      },
    };
  }

  async send(
    context: ResolvedProviderContext,
    request: ProviderTransportRequest
  ): Promise<Response> {
    const timeoutControl = createTimeoutSignal(
      request.signal,
      request.timeoutMs
    );

    const managed = await resolveManagedSendContext(context);
    const effectiveContext = managed ? managed.context : context;

    const prepared = this.prepareRequest(effectiveContext, {
      ...request,
      signal: timeoutControl.signal,
    });
    const finalPrepared = managed
      ? rewriteUrlToProxy(prepared, managed.proxyBase, managed.token)
      : prepared;
    const fetcher = request.fetcher || fetch;

    try {
      const response = await fetcher(finalPrepared.url, finalPrepared.init);

      if (managed) {
        const quotaError = await parseQuotaErrorFromResponse(response);
        if (quotaError) {
          throw quotaError;
        }
      }

      // 响应归档（方案 B，替代原 ai-proxy 服务端归档）：
      // 托管模式下携带 taskId 的请求（x-task-id 关联任务）拿到上游响应后，
      // fire-and-forget 将响应 JSON（含 base64 输出）转存 huabu bucket 并写
      // task_submissions.upstream_response。clone 读取，不消费原响应、不阻塞主流程；
      // 全程静默失败（未登录/未注册配置/非终态/非 JSON 均跳过）。
      if (managed && request.taskId) {
        void archiveUpstreamResponseFromFetch(request.taskId, response);
      }

      return response;
    } catch (error) {
      if (error instanceof ImageQuotaExceededError) {
        throw error;
      }
      if (timeoutControl.didTimeout()) {
        const timeoutMinutes = Math.floor((request.timeoutMs || 0) / 60000);
        const timeoutError = new Error(
          `请求超时（>${timeoutMinutes} 分钟）`
        );
        timeoutError.name = 'TimeoutError';
        throw timeoutError;
      }
      throw error;
    } finally {
      timeoutControl.cleanup();
    }
  }
}

export const providerTransport = new ProviderTransport();

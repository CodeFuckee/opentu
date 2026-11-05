/**
 * ai-proxy 客户端
 *
 * 复用托管生图链路（supabase/functions/ai-proxy）：
 * POST {SUPABASE_URL}/functions/v1/ai-proxy/v1/images/generations
 *   —— Bearer supabase JWT，网关注入上游密钥并扣配额
 * GET  {SUPABASE_URL}/functions/v1/ai-proxy/quota
 * x-task-id 头透传对账（与前端 provider-transport 契约一致）
 */

import { clampImageCount, normalizeImageDataUrl, randomTaskId } from './util.js';

export class AiProxyError extends Error {
  constructor(message, { status = 0, code = '', body = null } = {}) {
    super(message);
    this.name = 'AiProxyError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * 构建生图请求体（与前端 tuzi-gpt-image JSON 协议一致：
 * {model,prompt,n,size,quality,image[]}，n=1 省略）
 */
export function buildGenerationBody({
  model,
  prompt,
  n,
  size,
  quality,
  referenceImages,
}) {
  const body = { model, prompt };
  const count = clampImageCount(n);
  if (count > 1) body.n = count;
  if (size) body.size = size;
  if (quality) body.quality = quality;
  if (Array.isArray(referenceImages) && referenceImages.length > 0) {
    body.image = [...referenceImages];
  }
  return body;
}

/**
 * 解析同步生图响应：{data:[{url|b64_json, revised_prompt?}]}。
 * 违禁内容/无图检测语义与前端 parseImageResponse 一致。
 */
export function parseImageResponseItems(json) {
  const data = Array.isArray(json?.data) ? json.data : [];
  const items = [];
  for (const item of data) {
    const revised = item?.revised_prompt;
    if (typeof revised === 'string') {
      if (revised.includes('PROHIBITED_CONTENT')) {
        throw new AiProxyError('内容被拒绝：包含违禁内容', {
          code: 'prohibited_content',
        });
      }
      if (revised.includes('NO_IMAGE')) {
        throw new AiProxyError(
          '该模型为多模态模型，未生成图片，可更换提示词明确生成图片试试',
          { code: 'no_image' }
        );
      }
    }
    const url = typeof item?.url === 'string' ? item.url : '';
    if (url) {
      items.push({ kind: 'url', url: normalizeImageDataUrl(url) });
      continue;
    }
    const b64 = typeof item?.b64_json === 'string' ? item.b64_json : '';
    if (b64) {
      items.push({ kind: 'b64', b64 });
    }
  }
  if (items.length === 0) {
    throw new AiProxyError('上游响应不含可用的图片数据', {
      code: 'empty_response',
    });
  }
  return items;
}

export function createAiProxyClient({
  auth,
  config,
  fetchImpl = globalThis.fetch,
  taskIdFn = randomTaskId,
  logger = console,
}) {
  const proxyBase = `${config.supabaseUrl}/functions/v1/ai-proxy`;

  async function request(path, { method = 'GET', body, contentType, taskId, attempt = 0 } = {}) {
    const token = await auth.getAccessToken();
    const headers = { Authorization: `Bearer ${token}` };
    if (contentType) headers['Content-Type'] = contentType;
    if (taskId) headers['x-task-id'] = taskId;

    let res;
    try {
      res = await fetchImpl(`${proxyBase}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      throw new AiProxyError(`ai-proxy 请求失败: ${error?.message || error}`, {
        code: 'network',
      });
    }

    // 401 → 强制重登重试一次（token 被服务端吊销/过期边界）
    if (res.status === 401 && attempt < 1) {
      logger.warn?.('[ai-proxy] 401，刷新凭据后重试');
      auth.invalidate();
      return request(path, { method, body, contentType, taskId, attempt: attempt + 1 });
    }

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 非 JSON 响应（透传二进制等）按原文处理
    }
    if (!res.ok) {
      const code = typeof json?.error === 'string' ? json.error : '';
      const message =
        json?.message || (typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`);
      throw new AiProxyError(`ai-proxy ${path} 失败: ${message}`, {
        status: res.status,
        code,
        body: json,
      });
    }
    return { status: res.status, json, text };
  }

  /**
   * 生图。返回 {taskId, response}；taskId 生成于本函数（供交付/台账对齐），
   * 也可经 params.taskId 预置（工具层先写台账再生成时传入）。
   */
  async function generateImage(params) {
    const taskId = params.taskId || taskIdFn();
    const body = buildGenerationBody(params);
    const { json } = await request('/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify(body),
      contentType: 'application/json',
      taskId,
    });
    return { taskId, response: json };
  }

  /** 配额自查 → {limit, used, remaining, period} | null */
  async function getQuota() {
    const { json } = await request('/quota');
    return json?.quota ?? null;
  }

  return { generateImage, getQuota, proxyBase };
}

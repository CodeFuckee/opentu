/**
 * 托管上游路由运行时（managed upstream routing）
 *
 * 已登录用户的上游 AI 请求统一经自建 Supabase 边缘函数 ai-proxy 转发：
 * 浏览器只携带 Supabase JWT，API Key 由代理在服务端注入（user_profiles.apikey），
 * 图像生成的月度额度也在服务端计量与校验。
 *
 * 本模块只做三件事：
 * 1. 让宿主应用（apps/web）在登录态变化时注册/注销路由配置；
 * 2. 为 provider-transport 提供"是否启用托管改写"的同步查询；
 * 3. 提供额度查询 fetchImageQuota 与超额错误识别。
 *
 * 未注册配置（未登录或宿主未接入）时一切保持原有直连行为。
 */

export interface ManagedRoutingConfig {
  /** 自建 Supabase 根地址，如 http://10.37.80.25:8021 */
  supabaseUrl: string;
  /** 取当前会话 Supabase access_token；返回 null 视为暂不可用 */
  getToken: () => Promise<string | null>;
  /** 边缘函数路径前缀，默认 '/functions/v1/ai-proxy' */
  proxyPath?: string;
}

export interface ImageQuotaInfo {
  limit: number;
  used: number;
  remaining: number;
  period: string | null;
}

let currentConfig: ManagedRoutingConfig | null = null;

/** 注册/注销托管路由。传 null 表示回到本地直连模式。 */
export function configureManagedRouting(
  config: ManagedRoutingConfig | null
): void {
  currentConfig = config;
}

export function getManagedRoutingConfig(): ManagedRoutingConfig | null {
  return currentConfig;
}

/**
 * 是否启用托管上游改写。
 * 托管模式下所有经 provider-transport 的上游请求都隧道至 ai-proxy。
 */
export function isManagedUpstreamEnabled(): boolean {
  return currentConfig !== null;
}

function normalizeBase(url: string): string {
  return (url || '').trim().replace(/\/+$/, '');
}

export function getManagedProxyBase(): string | null {
  if (!currentConfig) {
    return null;
  }
  const base = normalizeBase(currentConfig.supabaseUrl);
  if (!base) {
    return null;
  }
  const path =
    currentConfig.proxyPath?.trim().replace(/\/+$/, '') ||
    '/functions/v1/ai-proxy';
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 额度耗尽的专用错误：UI 可据此给出明确文案 */
export class ImageQuotaExceededError extends Error {
  readonly remaining: number;

  constructor(message: string, remaining: number) {
    super(message);
    this.name = 'ImageQuotaExceededError';
    this.remaining = remaining;
  }
}

interface ProxyQuotaPayload {
  quota?: Partial<ImageQuotaInfo> | null;
  error?: string;
  message?: string;
  remaining?: number;
}

/** 查询当前用户本月生图额度 */
export async function fetchImageQuota(): Promise<ImageQuotaInfo> {
  if (!currentConfig) {
    throw new Error('托管路由未启用');
  }
  const proxyBase = getManagedProxyBase();
  if (!proxyBase) {
    throw new Error('托管路由配置不完整');
  }
  const token = await currentConfig.getToken();
  if (!token) {
    throw new Error('请先登录');
  }

  const response = await fetch(`${proxyBase}/quota`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`额度查询失败（${response.status}）`);
  }
  const payload = (await response.json()) as ProxyQuotaPayload;
  const quota = payload?.quota;
  return {
    limit: Number(quota?.limit ?? 0),
    used: Number(quota?.used ?? 0),
    remaining: Math.max(0, Number(quota?.remaining ?? 0)),
    period: typeof quota?.period === 'string' ? quota.period : null,
  };
}

/**
 * 判断代理错误响应是否为额度耗尽。
 * 返回 ImageQuotaExceededError 或 null（非配额类错误）。
 */
export async function parseQuotaErrorFromResponse(
  response: Response
): Promise<ImageQuotaExceededError | null> {
  if (response.status !== 403 && response.status !== 402 && response.status !== 429) {
    return null;
  }
  try {
    const cloned = response.clone();
    const payload = (await cloned.json()) as ProxyQuotaPayload;
    if (payload?.error === 'quota_exceeded') {
      return new ImageQuotaExceededError(
        payload.message ?? '本月图片生成额度已用完',
        Number(payload.remaining ?? 0)
      );
    }
  } catch {
    // 非 JSON 响应按普通错误处理
  }
  return null;
}

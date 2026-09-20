/**
 * Feedbackland 单点登录（SSO）跳转服务
 *
 * 点击画布左侧 Feedbackland 反馈按钮时，不再直接跳转反馈平台，而是打开
 * 同源中转页（apps/web/public/feedback-sso.html），由中转页向本窗口请求
 * 最新访问令牌，再向 feedbackland-sso Edge Function 换取一次性 magic link
 * token，最终在 Feedbackland 侧免登建立会话。
 *
 * 为什么需要中转页：带 token 的跳转必须先异步获取一次性 token，而浏览器会
 * 拦截"非用户手势上下文"的 window.open——点击时同步打开中转页（无拦截），
 * 异步流程全部在已打开的中转页内完成。
 *
 * 宿主接入（apps/web AuthProvider，与登录态无关地配置一次）：
 *   configureFeedbacklandSso({ supabaseUrl, anonKey, getToken })
 */
import { FEEDBACKLAND_URL } from '../constants';

/** 中转页相对路径（apps/web/public/feedback-sso.html） */
const TRANSIT_PAGE_PATH = '/feedback-sso.html';

/** Feedbackland 侧 SSO 回调页（[orgSubdomain]/auth/sso） */
const FEEDBACKLAND_SSO_CALLBACK_SUFFIX = '/auth/sso';

/** 中转页 → 画布：请求最新访问令牌的消息类型 */
const TOKEN_REQUEST_MESSAGE_TYPE = 'opentu-feedback-sso:request-token';

/** 画布 → 中转页：携带令牌的应答消息类型 */
const TOKEN_RESPONSE_MESSAGE_TYPE = 'opentu-feedback-sso:token';

export interface FeedbacklandSsoConfig {
  supabaseUrl: string;
  anonKey: string;
  /** 获取当前用户最新 access token；未登录返回 null */
  getToken: () => Promise<string | null>;
}

let ssoConfig: FeedbacklandSsoConfig | null = null;
let bridgeInstalled = false;

export function configureFeedbacklandSso(
  config: FeedbacklandSsoConfig | null
): void {
  ssoConfig = config;
  if (config) {
    installFeedbacklandSsoTokenBridge();
  }
}

export function isFeedbacklandSsoConfigured(): boolean {
  return ssoConfig !== null;
}

/**
 * 中转页地址：/feedback-sso.html?to=<Feedbackland 回调页>&su=<Supabase>&ak=<anon key>
 * 三个参数均为公开值（回调地址、网关地址、anon 公钥），不含任何机密；
 * 访问令牌不在 URL 中传递（由中转页经 postMessage 向画布实时索取）。
 */
export function buildFeedbacklandTransitPageUrl(): string {
  if (!ssoConfig) {
    throw new Error('Feedbackland SSO 未配置');
  }
  const params = new URLSearchParams({
    to: `${FEEDBACKLAND_URL}${FEEDBACKLAND_SSO_CALLBACK_SUFFIX}`,
    su: ssoConfig.supabaseUrl,
    ak: ssoConfig.anonKey,
  });
  return `${TRANSIT_PAGE_PATH}?${params.toString()}`;
}

/**
 * 同步打开中转页（用户手势上下文内调用，不会被弹窗拦截）。
 * 注意：不能带 noopener/noreferrer——中转页需要 window.opener 与画布
 * postMessage 握手换取令牌；被打开页面是自家同源静态页，无 tab-nabbing 风险。
 * 未配置（理论上不会发生：画布被 AuthGate 保护，进得来必然已登录且已配置）
 * 时返回 false，由调用方做"请先登录"的防御提示。
 */
export function openFeedbacklandSsoWindow(): boolean {
  if (!ssoConfig) {
    return false;
  }
  window.open(buildFeedbacklandTransitPageUrl(), '_blank');
  return true;
}

/**
 * 安装中转页的令牌桥（幂等）：中转页通过 postMessage 请求令牌时，
 * 用 getToken() 的最新结果（supabase-js 已自动续期）应答给同源请求方。
 * 跨源消息与无关消息一律忽略。
 */
function installFeedbacklandSsoTokenBridge(): void {
  if (bridgeInstalled || typeof window === 'undefined') {
    return;
  }
  bridgeInstalled = true;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== window.location.origin) {
      return;
    }
    const data = event.data as { type?: string } | null;
    if (!data || data.type !== TOKEN_REQUEST_MESSAGE_TYPE) {
      return;
    }
    if (!ssoConfig) {
      return;
    }
    const source = event.source as {
      postMessage: (message: unknown, targetOrigin: string) => void;
    } | null;
    if (!source) {
      return;
    }
    ssoConfig.getToken().then((token) => {
      // 应答前再校验一次配置仍存在，避免已注销后回写
      if (ssoConfig) {
        source.postMessage(
          { type: TOKEN_RESPONSE_MESSAGE_TYPE, token },
          event.origin
        );
      }
    }).catch((error) => {
      // 与既有失败路径一致：不向 iframe 回包（其等待超时自行处理），仅留痕
      console.warn('[FeedbacklandSSO] token 获取失败:', error);
    });
  });
}

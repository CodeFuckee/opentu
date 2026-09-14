import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACKLAND_URL } from '../../constants';
import {
  buildFeedbacklandTransitPageUrl,
  configureFeedbacklandSso,
  isFeedbacklandSsoConfigured,
  openFeedbacklandSsoWindow,
} from '../feedbackland-sso';

const CONFIG = {
  supabaseUrl: 'http://supabase.local:8021',
  anonKey: 'anon-key-test',
  getToken: vi.fn(async () => 'fresh-access-token'),
};

function makeSsoEvent(
  origin: string,
  source: { postMessage: (message: unknown, targetOrigin: string) => void }
): MessageEvent {
  return new MessageEvent('message', {
    origin,
    source: source as unknown as MessageEventSource,
    data: { type: 'opentu-feedback-sso:request-token' },
  });
}

describe('feedbackland-sso 服务', () => {
  beforeEach(() => {
    CONFIG.getToken = vi.fn(async () => 'fresh-access-token');
    vi.stubGlobal(
      'open',
      vi.fn(() => null)
    );
  });

  afterEach(() => {
    configureFeedbacklandSso(null);
    vi.unstubAllGlobals();
  });

  it('未配置时 openFeedbacklandSsoWindow 返回 false 且不开窗', () => {
    configureFeedbacklandSso(null);
    expect(isFeedbacklandSsoConfigured()).toBe(false);
    expect(openFeedbacklandSsoWindow()).toBe(false);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('配置后打开中转页：新标签页 + noopener，URL 携带 to/su/ak 参数', () => {
    configureFeedbacklandSso(CONFIG);
    expect(isFeedbacklandSsoConfigured()).toBe(true);

    expect(openFeedbacklandSsoWindow()).toBe(true);
    expect(window.open).toHaveBeenCalledTimes(1);
    const [url, target, features] = (window.open as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(url).toBe(buildFeedbacklandTransitPageUrl());
    expect(target).toBe('_blank');
    expect(features).toContain('noopener');

    const parsed = new URL(url as string, window.location.origin);
    expect(parsed.pathname).toBe('/feedback-sso.html');
    expect(parsed.searchParams.get('to')).toBe(`${FEEDBACKLAND_URL}/auth/sso`);
    expect(parsed.searchParams.get('su')).toBe(CONFIG.supabaseUrl);
    expect(parsed.searchParams.get('ak')).toBe(CONFIG.anonKey);
  });

  it('buildFeedbacklandTransitPageUrl 的回调地址 = FEEDBACKLAND_URL + /auth/sso', () => {
    configureFeedbacklandSso(CONFIG);
    const url = new URL(
      buildFeedbacklandTransitPageUrl(),
      window.location.origin
    );
    expect(url.searchParams.get('to')).toBe(`${FEEDBACKLAND_URL}/auth/sso`);
  });

  it('FEEDBACKLAND_URL 必须是合法的绝对 http/https 地址（避免空值/相对路径）', () => {
    expect(FEEDBACKLAND_URL).toMatch(/^https?:\/\//);
    expect(() => new URL(FEEDBACKLAND_URL)).not.toThrow();
  });

  it('token 桥：同源握手请求用 getToken 的最新结果应答', async () => {
    CONFIG.getToken = vi.fn(async () => 'token-from-getToken');
    configureFeedbacklandSso(CONFIG);

    const postMessage = vi.fn();
    window.dispatchEvent(makeSsoEvent(window.location.origin, { postMessage }));
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        { type: 'opentu-feedback-sso:token', token: 'token-from-getToken' },
        window.location.origin
      );
    });
  });

  it('token 桥：getToken 返回 null（未登录防御）时如实应答 null', async () => {
    CONFIG.getToken = vi.fn(async () => null);
    configureFeedbacklandSso(CONFIG);

    const postMessage = vi.fn();
    window.dispatchEvent(makeSsoEvent(window.location.origin, { postMessage }));
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        { type: 'opentu-feedback-sso:token', token: null },
        window.location.origin
      );
    });
  });

  it('token 桥：跨源消息一律不响应', async () => {
    configureFeedbacklandSso(CONFIG);
    const postMessage = vi.fn();
    window.dispatchEvent(
      makeSsoEvent('https://evil.example', { postMessage })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('token 桥：无关消息类型不响应', async () => {
    configureFeedbacklandSso(CONFIG);
    const postMessage = vi.fn();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: { postMessage } as unknown as MessageEventSource,
        data: { type: 'something-else' },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('重复 configure 幂等：监听器只注册一次，一条请求只收到一份应答', async () => {
    configureFeedbacklandSso(CONFIG);
    configureFeedbacklandSso(CONFIG);

    const postMessage = vi.fn();
    window.dispatchEvent(makeSsoEvent(window.location.origin, { postMessage }));
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledTimes(1);
    });
  });
});

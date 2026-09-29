import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../managed-routing/managed-runtime', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../managed-routing/managed-runtime')
  >();
  return {
    ...actual,
    isManagedUpstreamEnabled: vi.fn(() => false),
    getManagedRoutingConfig: vi.fn(() => null),
    getManagedProxyBase: vi.fn(() => null),
  };
});

vi.mock('../task-supabase-archive/service', () => ({
  archiveUpstreamResponseFromFetch: vi.fn(),
}));

import { ProviderTransport } from '../provider-routing/provider-transport';
import type { ResolvedProviderContext } from '../provider-routing/types';

const context: ResolvedProviderContext = {
  profileId: 'p1',
  profileName: 'Profile',
  providerType: 'custom',
  baseUrl: 'https://gateway.example.com/v1',
  apiKey: '',
  authType: 'bearer',
};

const okResponse = () => new Response('{"ok":true}', { status: 200 });

describe('provider-transport 提交期网络瞬断自动重试', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('首试秒级 TypeError（Failed to fetch 形态）→ 单次重试成功并返回响应', async () => {
    vi.useFakeTimers();
    const transport = new ProviderTransport();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okResponse());
    const p = transport.send(context, {
      path: '/images/generations',
      method: 'POST',
      body: '{"model":"m"}',
      fetcher,
    });
    await vi.advanceTimersByTimeAsync(1000); // 覆盖退避延时
    await expect(p).resolves.toBeInstanceOf(Response);
    const res = await p;
    expect(res.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetcher.mock.calls[0];
    const [url2, init2] = fetcher.mock.calls[1];
    expect(url1).toBe(url2);
    expect(init1).toBe(init2); // 同一请求体/头/信号原样重试
  });

  it('慢失败（>3s 才抛 TypeError，响应丢失型）→ 不重试直接抛出', async () => {
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0) // startedAt
      .mockReturnValue(5000); // catch 时 elapsed=5000ms
    const transport = new ProviderTransport();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(
      transport.send(context, {
        path: '/images/generations',
        method: 'POST',
        fetcher,
      })
    ).rejects.toThrow('Failed to fetch');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(nowSpy).toHaveBeenCalled();
  });

  it('AbortError（用户取消/超时）不重试', async () => {
    const transport = new ProviderTransport();
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(abortError);
    await expect(
      transport.send(context, {
        path: '/images/generations',
        method: 'POST',
        fetcher,
      })
    ).rejects.toThrow('aborted');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('首试取消（signal.aborted）后不重试', async () => {
    const transport = new ProviderTransport();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      throw new TypeError('Failed to fetch');
    });
    await expect(
      transport.send(context, {
        path: '/images/generations',
        method: 'POST',
        signal: controller.signal,
        fetcher,
      })
    ).rejects.toThrow('Failed to fetch');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('重试仍失败 → 抛第二次错误，不叠加第三次尝试', async () => {
    vi.useFakeTimers();
    const transport = new ProviderTransport();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const p = transport.send(context, {
      path: '/images/generations',
      method: 'POST',
      fetcher,
    });
    // 先挂断言再推进假计时器，避免 p 在获得 handler 前拒绝产生 unhandled rejection
    const assertion = expect(p).rejects.toThrow('Failed to fetch');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

/**
 * task_id 契约：请求携带 taskId 时附加 x-task-id 头（供 ai-proxy 服务端响应归档关联行）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerTransport } from '../provider-routing';
import type { ResolvedProviderContext } from '../provider-routing';
import { configureManagedRouting } from '../managed-routing/managed-runtime';

const HEADER_KEY = 'x-task-id';

function makeContext(overrides: Partial<ResolvedProviderContext> = {}): ResolvedProviderContext {
  return {
    profileId: 'p1',
    profileName: 'P1',
    providerType: 'custom',
    baseUrl: 'https://gateway.example.com/v1',
    apiKey: 'sk-test',
    authType: 'bearer',
    extraHeaders: {},
    ...overrides,
  };
}

describe('providerTransport taskId → x-task-id 头', () => {
  afterEach(() => {
    configureManagedRouting(null);
    vi.restoreAllMocks();
  });

  it('带 taskId → prepareRequest 附加 x-task-id 头', () => {
    const prepared = providerTransport.prepareRequest(makeContext(), {
      taskId: 'task-1',
      path: '/v1/images/generations',
      method: 'POST',
      body: '{}',
    });
    expect(prepared.headers[HEADER_KEY]).toBe('task-1');
    const initHeaders = prepared.init.headers as Record<string, string>;
    expect(initHeaders[HEADER_KEY]).toBe('task-1');
  });

  it('无 taskId → 不附加 x-task-id 头', () => {
    const prepared = providerTransport.prepareRequest(makeContext(), {
      path: '/v1/images/generations',
      method: 'POST',
      body: '{}',
    });
    expect((prepared.headers as Record<string, string>)[HEADER_KEY]).toBeUndefined();
  });

  it('托管模式下 send 保留 x-task-id 并改写 URL 到 ai-proxy', async () => {
    configureManagedRouting({
      supabaseUrl: 'http://sb.local',
      getToken: async () => 'jwt-token',
    });
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        headers: (init?.headers as Record<string, string>) || {},
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await providerTransport.send(
      makeContext(),
      {
        taskId: 'task-managed-1',
        path: '/images/generations',
        method: 'POST',
        body: '{}',
        fetcher: fetchMock,
      }
    );

    expect(seen).toHaveLength(1);
    // baseUrl 含 /v1（https://gateway.example.com/v1），改写后保留真实上游路径
    expect(seen[0].url).toMatch(/\/functions\/v1\/ai-proxy\/v1\/images\/generations$/);
    expect(seen[0].headers[HEADER_KEY]).toBe('task-managed-1');
    expect(seen[0].headers.Authorization).toBe('Bearer jwt-token');
  });

  it('托管 + taskId：响应不影响主流程（未注册归档配置时静默跳过）', async () => {
    configureManagedRouting({
      supabaseUrl: 'http://sb.local',
      getToken: async () => 'jwt-token',
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ data: [{ b64_json: 'YWJj' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(
      providerTransport.send(
        makeContext(),
        {
          taskId: 'task-managed-2',
          path: '/images/generations',
          method: 'POST',
          body: '{}',
          fetcher: fetchMock,
        }
      )
    ).resolves.toBeInstanceOf(Response);
  });
});
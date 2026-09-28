/**
 * resolveEditorImageSource 单测:非安全上下文(无 SW)虚拟 URL 降级解析。
 * jsdom 默认无 navigator.serviceWorker,正好覆盖降级分支;
 * SW 可用分支用 defineProperty 注入假 API 验证。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveEditorImageSource } from './resolve-editor-image-source';

const getCachedBlobMock = vi.fn();

vi.mock('../../services/unified-cache-service', () => ({
  unifiedCacheService: { getCachedBlob: (...args: unknown[]) => getCachedBlobMock(...args) },
}));

const VIRTUAL_URL = '/__aitu_cache__/image/content-fnv123.png';

let createObjectURLSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getCachedBlobMock.mockReset();
  // jsdom 未实现 createObjectURL,手动 stub 并记录调用
  createObjectURLSpy = vi.fn((blob: Blob) => `blob:mock-${(blob as { size: number }).size}`);
  vi.stubGlobal('URL', { ...URL, createObjectURL: createObjectURLSpy });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveEditorImageSource(无 SW 的纯 HTTP 内网环境)', () => {
  it('虚拟 URL + 缓存命中 → 返回 objectURL(供 revoke)', async () => {
    getCachedBlobMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    const r = await resolveEditorImageSource(VIRTUAL_URL);
    expect(r.src).toBe('blob:mock-1');
    expect(r.objectUrl).toBe('blob:mock-1');
    expect(getCachedBlobMock).toHaveBeenCalledWith(VIRTUAL_URL);
  });

  it('虚拟 URL + 缓存 miss → 原样返回(objectUrl=null,由加载方 onerror 报错)', async () => {
    getCachedBlobMock.mockResolvedValue(null);
    const r = await resolveEditorImageSource(VIRTUAL_URL);
    expect(r).toEqual({ src: VIRTUAL_URL, objectUrl: null });
  });

  it('虚拟 URL + 零字节 blob → 视同 miss 原样返回', async () => {
    getCachedBlobMock.mockResolvedValue(new Blob([], { type: 'image/png' }));
    const r = await resolveEditorImageSource(VIRTUAL_URL);
    expect(r.src).toBe(VIRTUAL_URL);
    expect(r.objectUrl).toBeNull();
  });

  it('虚拟 URL + getCachedBlob 抛错 → 原样返回不抛出', async () => {
    getCachedBlobMock.mockRejectedValue(new Error('idb broken'));
    const r = await resolveEditorImageSource(VIRTUAL_URL);
    expect(r.src).toBe(VIRTUAL_URL);
  });

  it('非虚拟 URL(data:/桶直链/外部 http)→ 原样返回且不查缓存', async () => {
    for (const url of [
      'data:image/png;base64,xxx',
      'http://10.37.80.25:8021/storage/v1/object/public/ai-outputs/a/1.png',
      'https://up.example.com/x.jpg',
    ]) {
      const r = await resolveEditorImageSource(url);
      expect(r).toEqual({ src: url, objectUrl: null });
    }
    expect(getCachedBlobMock).not.toHaveBeenCalled();
  });
});

describe('resolveEditorImageSource(SW 可用的安全上下文)', () => {
  it('虚拟 URL 直接原样返回,不触发降级查询', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: null },
    });
    try {
      const r = await resolveEditorImageSource(VIRTUAL_URL);
      expect(r).toEqual({ src: VIRTUAL_URL, objectUrl: null });
      expect(getCachedBlobMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: undefined,
      });
    }
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { clearCacheBlobFallbacks } from '../cache-blob-fallback-store';
import { unifiedCacheService } from '../unified-cache-service';

const URL = '/asset-library/content-debug123.png';

/**
 * 非安全上下文（纯 HTTP 内网部署）没有 Cache API / Service Worker，
 * 媒体 Blob 必须能通过 IndexedDB 兜底存储完成 cacheMediaFromBlob → getCachedBlob
 * 闭环，否则画布/素材库虚拟 URL 全部 404（jsdom 下 typeof caches === 'undefined'，
 * 恰好模拟该环境）。
 */
describe('unified-cache degraded (no caches API) integration', () => {
  afterEach(async () => {
    await unifiedCacheService.deleteCache(URL).catch(() => undefined);
    await clearCacheBlobFallbacks();
  });

  it('cacheMediaFromBlob -> getCachedBlob round trip without Cache API', async () => {
    const blob = new Blob(['degraded-bytes'], { type: 'image/png' });
    const stored = await unifiedCacheService.cacheMediaFromBlob(
      URL,
      blob,
      'image',
      {
        metadata: {},
        contentHash: 'debug-content-hash',
      } as any
    );
    expect(stored).toBe(URL);

    const read = await unifiedCacheService.getCachedBlob(URL);
    expect(read).not.toBeNull();
    expect(read!.type).toBe('image/png');
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(read!);
    });
    expect(text).toBe('degraded-bytes');
  });

  it('cacheMediaFromBlob -> getCachedBlob -> deleteCache clears blob', async () => {
    const blob = new Blob(['to-delete'], { type: 'image/png' });
    await unifiedCacheService.cacheMediaFromBlob(URL, blob, 'image', {
      metadata: {},
      contentHash: 'debug-content-hash',
    } as any);

    await unifiedCacheService.deleteCache(URL);

    expect(await unifiedCacheService.getCachedBlob(URL)).toBeNull();
  });
});

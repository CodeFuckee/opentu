// @vitest-environment jsdom
/**
 * 画板 Base64 图片迁移的 HTTP 环境复现测试
 *
 * 生产实证（2026-11-23，LAN 明文 HTTP 8088）：打开画板即刷
 * `[Migration] Failed to cache Base64 image: ReferenceError: caches is not defined`
 * —— cacheBase64ImageToVirtualPath 直接 `caches.open(...)`，非安全上下文没有
 * Cache API，迁移每次失败且永不完成。
 *
 * 更深的同类问题：旧实现直写 Cache API、绕过 unifiedCacheService，迁出来的
 * 虚拟 URL 图片**从不上云**——与素材库 fnv 图片同类的「字节困在单浏览器」孤儿。
 *
 * 修复后行为：经 unifiedCacheService.cacheLocalMediaByContent 落盘——
 * HTTP 下写 IDB 兜底库（getCachedBlob 可读），URL 为内容寻址（跨设备迁移同一
 * base64 收敛到同一 URL），并触发媒体二进制通道上云。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearCacheBlobFallbacks } from './cache-blob-fallback-store';
import { unifiedCacheService } from './unified-cache-service';
// 被测函数当前未导出——修复时一并导出（测试先行，此刻 import 会失败视为红）
import { cacheBase64ImageToVirtualPath } from './workspace-storage-service';

/** 1x1 PNG 的 base64（合法图片字节，魔数可过 isLikelyMediaBlob） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('画板 Base64 迁移（无 Cache API 的 HTTP 环境）', () => {
  afterEach(async () => {
    await clearCacheBlobFallbacks();
  });

  it('base64 → 内容寻址虚拟 URL，且 blob 落地本地可读（jsdom 无 caches）', async () => {
    const dataUrl = `data:image/png;base64,${PNG_BASE64}`;
    const result = await cacheBase64ImageToVirtualPath(dataUrl);

    expect(result).toMatch(/^\/__aitu_cache__\/image\/content-/);
    expect(result.startsWith('data:')).toBe(false);

    const blob = await unifiedCacheService.getCachedBlob(result);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/png');
    expect(blob!.size).toBeGreaterThan(0);
  });

  it('同一 base64 迁移两次收敛到同一 URL（内容寻址幂等）', async () => {
    const dataUrl = `data:image/png;base64,${PNG_BASE64}`;
    const first = await cacheBase64ImageToVirtualPath(dataUrl);
    const second = await cacheBase64ImageToVirtualPath(dataUrl);
    expect(second).toBe(first);
  });
});

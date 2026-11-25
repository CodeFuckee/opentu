// @vitest-environment jsdom
/**
 * ensureBase64ForAI 虚拟 URL 分支测试
 *
 * 2026-11-25 起聊天附件/参考图落库为内容寻址虚拟 URL（/asset-library/、
 * /__aitu_cache__/）——发上游 API 时需转回 base64：从本地（Cache/IDB 兜底）
 * 读取并压缩到 ≤1MB；读取失败显式报错（不把虚拟路径发给上游）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureBase64ForAI } from './fallback-utils';

const mocks = vi.hoisted(() => ({
  getCachedBlob: vi.fn(),
}));

vi.mock('../unified-cache-service', () => ({
  unifiedCacheService: {
    getCachedBlob: mocks.getCachedBlob,
  },
}));


function pngBlob(sizeText: string): Blob {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...new TextEncoder().encode(sizeText),
  ]);
  const blob = new Blob([bytes], { type: 'image/png' }) as Blob & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  blob.arrayBuffer = async () => bytes.buffer.slice(0);
  return blob;
}

describe('ensureBase64ForAI：虚拟 URL 分支', () => {
  beforeEach(() => {
    mocks.getCachedBlob.mockReset();
  });

  it('虚拟 URL → 本地读取 → ≤1MB 压缩转 base64', async () => {
    const blob = pngBlob('x'.repeat(64));
    mocks.getCachedBlob.mockResolvedValue(blob);

    const result = await ensureBase64ForAI({
      type: 'base64',
      value: '/__aitu_cache__/image/content-abc.png',
    });

    expect(result.startsWith('data:image/')).toBe(true);
    expect(mocks.getCachedBlob).toHaveBeenCalledWith(
      '/__aitu_cache__/image/content-abc.png'
    );
  });

  it('本地读取失败 → 显式报错（绝不把虚拟路径原样发给上游）', async () => {
    mocks.getCachedBlob.mockResolvedValue(null);
    await expect(
      ensureBase64ForAI({
        type: 'base64',
        value: '/asset-library/content-missing.png',
      })
    ).rejects.toThrow(/虚拟路径图片读取失败/);
  });

  it('data URL 行为不变（回归）；http(s) URL 走 fetch+压缩', async () => {
    const smallDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    expect(
      await ensureBase64ForAI({ type: 'base64', value: smallDataUrl })
    ).toBe(smallDataUrl);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        ok: true,
        blob: async () => pngBlob('http-bytes'),
      } as unknown as Response);
    try {
      const result = await ensureBase64ForAI({
        type: 'url',
        value: 'https://cdn.example.com/a.png',
      });
      expect(result.startsWith('data:image/')).toBe(true);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

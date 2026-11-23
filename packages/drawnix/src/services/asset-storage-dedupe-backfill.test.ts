// @vitest-environment jsdom
/**
 * addAsset 去重命中时的本机/云端二进制回填复现测试
 *
 * 生产实证（2026-11-23）：历史 orphan 图片（云端 user_sync_media 无行、本机无
 * blob）即使重新上传同一文件也无效——findAssetByContentHash 命中后直接 return，
 * 不写本地缓存、不触发上云，「图片空白 + 404」永远无法自愈。
 *
 * 修复后行为（去重命中时）：
 * - 本机无 blob → cacheMediaFromBlob 回填本地（HTTP 下 IDB 兜底库）并触发上云；
 * - 本机有 blob → 仍调用 uploadMediaBinaryToCloud 补一次云端检查（幂等，哈希
 *   一致自动跳过）——只有字节的那台老浏览器无需删除素材即可自愈云端；
 * - 回填失败不阻塞去重返回（warn）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assetStorageService } from './asset-storage-service';

const mocks = vi.hoisted(() => ({
  loadEntitiesByTypes: vi.fn().mockResolvedValue([]),
  loadContent: vi.fn().mockResolvedValue(null),
  saveEntity: vi.fn().mockResolvedValue(undefined),
  deleteEntities: vi.fn().mockResolvedValue(undefined),
  getCachedBlob: vi.fn().mockResolvedValue(null),
  cacheMediaFromBlob: vi.fn().mockResolvedValue('/asset-library/content-dup.png'),
  uploadMediaBinaryToCloud: vi.fn().mockResolvedValue(true),
  track: vi.fn(),
}));

vi.mock('./supabase-sync/cloud-direct-store', () => ({
  cloudDirectStore: {
    loadEntitiesByTypes: mocks.loadEntitiesByTypes,
    loadContent: mocks.loadContent,
    saveEntity: mocks.saveEntity,
    deleteEntities: mocks.deleteEntities,
  },
  isCloudOnlyStorage: () => true,
}));
vi.mock('./unified-cache-service', () => ({
  unifiedCacheService: {
    getCachedBlob: mocks.getCachedBlob,
    cacheMediaFromBlob: mocks.cacheMediaFromBlob,
  },
}));
vi.mock('./supabase-sync/media-binary-channel', () => ({
  uploadMediaBinaryToCloud: mocks.uploadMediaBinaryToCloud,
}));
vi.mock('./supabase-sync/change-bus', () => ({
  changeBus: { emit: vi.fn() },
}));
vi.mock('../utils/posthog-analytics', () => ({
  analytics: { track: mocks.track },
}));
vi.mock('../utils/storage-quota', () => ({
  canAddAssetBySize: vi.fn().mockResolvedValue(true),
}));

/** 本机真实媒体 blob（PNG 魔数），补 jsdom 缺失的 arrayBuffer */
function pngBlob(text = 'dup-bytes'): Blob {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ...new TextEncoder().encode(text),
  ]);
  const blob = new Blob([bytes], { type: 'image/png' }) as Blob & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  blob.arrayBuffer = async () => bytes.buffer.slice(0);
  return blob;
}

const STORED = {
  id: 'a1',
  url: '/asset-library/content-duphash123.png',
  type: 'IMAGE',
  source: 'LOCAL',
  name: 'dup.png',
  mimeType: 'image/png',
  createdAt: 1,
  size: 100,
  contentHash: 'duphash123',
};

/** 测试用基准 blob：夹具的 contentHash/size 必须与它的真实校验和/大小一致，
 * 否则 findAssetByContentHash 不命中、去重路径根本不会执行 */
let fixtureBlob: Blob;
let fixtureHash: string;

describe('addAsset 去重命中的二进制回填', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fixtureBlob = pngBlob();
    const { calculateBlobChecksum } = await import('@aitu/utils');
    fixtureHash = await calculateBlobChecksum(fixtureBlob);
    mocks.loadEntitiesByTypes.mockResolvedValue([
      {
        entity_type: 'asset',
        entity_id: STORED.id,
        content: { ...STORED, size: fixtureBlob.size, contentHash: fixtureHash },
        updated_at: Date.now(),
        deleted_at: null,
      },
    ]);
    mocks.loadContent.mockResolvedValue({
      ...STORED,
      size: fixtureBlob.size,
      contentHash: fixtureHash,
    });
    await assetStorageService.initialize();
  });

  it('本机无 blob：回填 cacheMediaFromBlob（写本地 + 触发上云）', async () => {
    mocks.getCachedBlob.mockResolvedValue(null);

    const result = await assetStorageService.addAsset({
      type: 'IMAGE',
      source: 'LOCAL',
      name: 'dup.png',
      blob: fixtureBlob,
      mimeType: 'image/png',
    });

    expect(result.id).toBe(STORED.id); // 仍返回已有素材（去重语义不变）
    expect(mocks.cacheMediaFromBlob).toHaveBeenCalledTimes(1);
    expect(mocks.cacheMediaFromBlob).toHaveBeenCalledWith(
      STORED.url,
      expect.any(Blob),
      'image',
      expect.objectContaining({ contentHash: fixtureHash })
    );
  });

  it('本机有 blob：补一次 uploadMediaBinaryToCloud（云端无行则自愈上云）', async () => {
    mocks.getCachedBlob.mockResolvedValue(pngBlob('local-has-bytes'));

    await assetStorageService.addAsset({
      type: 'IMAGE',
      source: 'LOCAL',
      name: 'dup.png',
      blob: fixtureBlob,
      mimeType: 'image/png',
    });

    expect(mocks.cacheMediaFromBlob).not.toHaveBeenCalled();
    expect(mocks.uploadMediaBinaryToCloud).toHaveBeenCalledTimes(1);
    expect(mocks.uploadMediaBinaryToCloud).toHaveBeenCalledWith(
      STORED.url,
      expect.any(Blob),
      'image'
    );
  });

  it('回填失败不阻塞去重返回', async () => {
    mocks.getCachedBlob.mockResolvedValue(null);
    mocks.cacheMediaFromBlob.mockRejectedValue(new Error('quota exceeded'));

    const result = await assetStorageService.addAsset({
      type: 'IMAGE',
      source: 'LOCAL',
      name: 'dup.png',
      blob: fixtureBlob,
      mimeType: 'image/png',
    });

    expect(result.id).toBe(STORED.id);
  });
});

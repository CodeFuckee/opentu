/**
 * media-sync 毒化数据防护测试
 *
 * 核心问题：跨设备同步时，非媒体字节（dev server / 网关的 200 HTML 兜底页）被
 * 当作图片上传/下载/缓存，导致另一台设备的画布图片解码失败且无法自愈。
 *
 * 覆盖的防护链路：
 * 1. 下载侧：云端行指向 HTML 对象 → 拒绝缓存（不污染本机 Cache）
 * 2. 下载侧：本机已有「毒化 blob」（HTML）→ 不能跳过下载，仍要下载真实二进制覆盖
 * 3. 上传侧：本地 blob 非媒体 → 不上传（不把毒化传播到云端）
 * 4. 上传侧：content- URL 的远端行 storage_path 哈希与本地 blob 不一致
 *    （云端对象毒化/过期）→ 重传覆盖，实现云端自愈
 * 5. 上传侧：远端行哈希一致 → 不重复上传
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CONTENT_URL = '/asset-library/content-abc123.png';

describe('media-sync：毒化数据防护', () => {
  const repoMocks = vi.hoisted(() => ({
    fetchRemoteMedia: vi.fn().mockResolvedValue({ media: [], error: null }),
    upsertRemoteMedia: vi.fn().mockResolvedValue({ error: null }),
  }));

  const cacheMocks = vi.hoisted(() => ({
    getCachedBlob: vi.fn(),
    getAllCacheMetadata: vi.fn().mockResolvedValue([]),
    cacheToCacheStorageOnly: vi.fn().mockResolvedValue(true),
  }));

  vi.mock('./repository', () => ({
    fetchRemoteMedia: repoMocks.fetchRemoteMedia,
    upsertRemoteMedia: repoMocks.upsertRemoteMedia,
  }));

  vi.mock('../unified-cache-service', () => ({
    unifiedCacheService: {
      getCachedBlob: cacheMocks.getCachedBlob,
      getAllCacheMetadata: cacheMocks.getAllCacheMetadata,
      cacheToCacheStorageOnly: cacheMocks.cacheToCacheStorageOnly,
    },
  }));

  /** 本地真实媒体 blob（魔数为 PNG）+ jsdom 补齐 arrayBuffer */
  function pngBlob(): Blob {
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    const blob = new Blob([bytes], { type: 'image/png' }) as Blob & {
      arrayBuffer?: () => Promise<ArrayBuffer>;
    };
    blob.arrayBuffer = async () => bytes.buffer.slice(0);
    return blob;
  }

  /** HTML 毒化 blob（dev server 兜底页特征） */
  function htmlBlob(): Blob {
    const bytes = new TextEncoder().encode(
      '<!DOCTYPE html><html lang="zh-CN"><head><script src="/src/main.tsx"></script></head><body></body></html>'
    );
    const blob = new Blob([bytes], { type: 'text/plain' }) as Blob & {
      arrayBuffer?: () => Promise<ArrayBuffer>;
    };
    blob.arrayBuffer = async () => bytes.buffer.slice(0);
    return blob;
  }

  function makeClient(): { client: Record<string, unknown>; uploaded: Array<{ path: string; blob: Blob }> } {
    const uploaded: Array<{ path: string; blob: Blob }> = [];
    const client = {
      auth: {
        getSession: async () => ({
          data: {
            session: { user: { id: 'u1', email: 'e2e_user@yjk.com' } },
          },
        }),
      },
      from: (table: string) => {
        if (table === 'user_profiles') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      storage: {
        from: () => ({
          upload: async (path: string, blob: Blob) => {
            uploaded.push({ path, blob });
            return { error: null };
          },
          download: async () => ({ data: null, error: { message: 'not configured' } }),
        }),
      },
    };
    return { client, uploaded };
  }

  beforeEach(() => {
    // mockReset 清掉上个用例的 mockResolvedValue，回退默认实现，避免跨用例泄漏
    repoMocks.fetchRemoteMedia.mockReset().mockResolvedValue({ media: [], error: null });
    repoMocks.upsertRemoteMedia.mockReset().mockResolvedValue({ error: null });
    cacheMocks.getCachedBlob.mockReset().mockResolvedValue(null);
    cacheMocks.getAllCacheMetadata.mockReset().mockResolvedValue([]);
    cacheMocks.cacheToCacheStorageOnly.mockReset().mockResolvedValue(true);
    // 固定 sha256（07*32），便于构造/断言 storage_path
    vi.stubGlobal('crypto', {
      subtle: {
        digest: async () => new Uint8Array(32).fill(7),
      },
    });
  });

  it('下载侧：云端对象为 HTML（毒化）→ 拒绝缓存并记为失败', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    cacheMocks.getAllCacheMetadata.mockResolvedValue([]); // 本地无任何媒体
    repoMocks.fetchRemoteMedia.mockResolvedValue({
      media: [
        { url: CONTENT_URL, type: 'image', storagePath: 'e2e_user/image/aaaaaaaa.png' },
      ],
      error: null,
    });
    const client = {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: 'u1', email: 'e2e_user@yjk.com' } } },
        }),
      },
      from: (table: string) => {
        if (table === 'user_profiles') {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null }) }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      storage: {
        from: () => ({
          // 云端行指向的对象内容其实是 HTML 页面
          download: async () => ({ data: htmlBlob(), error: null }),
        }),
      },
    };
    const stats = await syncMediaToSupabase({ client } as never, 'u1');
    // 不能把 HTML 写进本机 Cache（否则 <img> 解码失败且无法自愈）
    expect(stats).toEqual({ uploaded: 0, downloaded: 0, failed: 1 });
    expect(cacheMocks.cacheToCacheStorageOnly).not.toHaveBeenCalled();
  });

  it('下载侧：本机已有毒化 blob（HTML）→ 不跳过下载，用真实二进制覆盖', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    cacheMocks.getAllCacheMetadata.mockResolvedValue([
      { id: 'm1', url: CONTENT_URL, cachedAt: Date.now() },
    ]);
    repoMocks.fetchRemoteMedia.mockResolvedValue({
      media: [
        { url: CONTENT_URL, type: 'image', storagePath: 'e2e_user/image/aaaaaaaa.png' },
      ],
      error: null,
    });
    // 本机缓存里已有「媒体」——但内容是 HTML 兜底页（毒化）
    cacheMocks.getCachedBlob.mockResolvedValue(htmlBlob());
    const client = {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: 'u1', email: 'e2e_user@yjk.com' } } },
        }),
      },
      from: (table: string) => {
        if (table === 'user_profiles') {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null }) }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      storage: {
        from: () => ({
          download: async () => ({ data: pngBlob(), error: null }),
        }),
      },
    };
    const stats = await syncMediaToSupabase({ client } as never, 'u1');
    // 毒化 blob 不能阻止真实二进制的下载
    expect(stats.downloaded).toBe(1);
    expect(cacheMocks.cacheToCacheStorageOnly).toHaveBeenCalledTimes(1);
  });

  it('上传侧：本地 blob 非媒体（HTML）→ 不上传，不毒化云端', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    cacheMocks.getAllCacheMetadata.mockResolvedValue([
      { id: 'm1', url: CONTENT_URL, cachedAt: Date.now() },
    ]);
    cacheMocks.getCachedBlob.mockResolvedValue(htmlBlob());
    const { client, uploaded } = makeClient();
    const stats = await syncMediaToSupabase({ client } as never, 'u1');
    expect(stats).toEqual({ uploaded: 0, downloaded: 0, failed: 0 });
    expect(uploaded).toHaveLength(0);
    expect(repoMocks.upsertRemoteMedia).not.toHaveBeenCalled();
  });

  it('上传侧：content- URL 远端行哈希与本地不一致（云端毒化）→ 重传覆盖自愈', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    cacheMocks.getAllCacheMetadata.mockResolvedValue([
      { id: 'm1', url: CONTENT_URL, cachedAt: Date.now() },
    ]);
    cacheMocks.getCachedBlob.mockResolvedValue(pngBlob());
    // 远端行存在，但 storage_path 哈希（aa..）与本地 blob sha256（07..）不一致
    repoMocks.fetchRemoteMedia.mockResolvedValue({
      media: [
        { url: CONTENT_URL, type: 'image', storagePath: 'e2e_user/image/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png' },
      ],
      error: null,
    });
    const { client, uploaded } = makeClient();
    const stats = await syncMediaToSupabase({ client } as never, 'u1');
    // 自愈：重新上传真实二进制并更新行（url 保真）
    expect(stats.uploaded).toBe(1);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].path).toBe(
      'e2e_user/image/0707070707070707070707070707070707070707070707070707070707070707.png'
    );
    expect(repoMocks.upsertRemoteMedia).toHaveBeenCalledTimes(1);
    const items = repoMocks.upsertRemoteMedia.mock.calls[0][2] as Array<{ url: string; storagePath: string }>;
    expect(items[0].url).toBe(CONTENT_URL);
    expect(items[0].storagePath).toContain('0707070707070707070707070707070707070707070707070707070707070707');
  });

  it('上传侧：远端行哈希与本地一致 → 不重复上传', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    cacheMocks.getAllCacheMetadata.mockResolvedValue([
      { id: 'm1', url: CONTENT_URL, cachedAt: Date.now() },
    ]);
    cacheMocks.getCachedBlob.mockResolvedValue(pngBlob());
    repoMocks.fetchRemoteMedia.mockResolvedValue({
      media: [
        { url: CONTENT_URL, type: 'image', storagePath: 'e2e_user/image/0707070707070707070707070707070707070707070707070707070707070707.png' },
      ],
      error: null,
    });
    const { client, uploaded } = makeClient();
    const stats = await syncMediaToSupabase({ client } as never, 'u1');
    expect(stats).toEqual({ uploaded: 0, downloaded: 0, failed: 0 });
    expect(uploaded).toHaveLength(0);
    expect(repoMocks.upsertRemoteMedia).not.toHaveBeenCalled();
  });

  it('上传侧：非 content- URL（uuid 素材）不改写远端行（保持原跳过行为）', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    const uuidUrl = '/asset-library/87501b99-6c6d-4053-8b38-37bfaabce9a3.png';
    cacheMocks.getAllCacheMetadata.mockResolvedValue([
      { id: 'm1', url: uuidUrl, cachedAt: Date.now() },
    ]);
    cacheMocks.getCachedBlob.mockResolvedValue(pngBlob());
    repoMocks.fetchRemoteMedia.mockResolvedValue({
      media: [
        { url: uuidUrl, type: 'image', storagePath: 'e2e_user/image/old-style-path.png' },
      ],
      error: null,
    });
    const { client, uploaded } = makeClient();
    const stats = await syncMediaToSupabase({ client } as never, 'u1');
    expect(stats).toEqual({ uploaded: 0, downloaded: 0, failed: 0 });
    expect(uploaded).toHaveLength(0);
    expect(repoMocks.upsertRemoteMedia).not.toHaveBeenCalled();
  });
});
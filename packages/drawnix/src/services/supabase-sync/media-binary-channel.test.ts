// @vitest-environment jsdom
/**
 * 云端唯一存储模式下媒体二进制通道复现测试
 *
 * 背景（2026-11-23 生产实证）：云端唯一存储默认开启后 reconcileFull 一律拒绝，
 * 而媒体二进制的上传/下载（user_sync_media + yue-sync 桶）只存在于 reconcileFull
 * 内 —— addAsset 落库的虚拟 URL 图片字节只留在上传浏览器的 IndexedDB 兜底库，
 * 其他浏览器只有元数据：画布图片空白 + /asset-library/ 404 刷屏 +
 * getImageForAI 报 "Virtual URL not found in cache"。
 *
 * 复现两条断言（修复前必失败）：
 * A. cacheMediaFromBlob(虚拟 URL) 后，二进制应上传 yue-sync + upsert user_sync_media
 * B. 本地无 blob 时 getCachedBlob(虚拟 URL) 应从云端下载回填并返回 blob
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UPLOAD_URL = '/asset-library/content-repro-upload.png';
const DOWNLOAD_URL = '/asset-library/content-repro-download.png';

const repoMocks = vi.hoisted(() => ({
  fetchRemoteMediaByUrl: vi
    .fn()
    .mockResolvedValue({ media: null, error: null }),
  upsertRemoteMedia: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('./repository', () => ({
  // 只替换媒体通道用到的两个入口，其余（实体读写）保持原实现
  fetchRemoteMediaByUrl: repoMocks.fetchRemoteMediaByUrl,
  upsertRemoteMedia: repoMocks.upsertRemoteMedia,
}));

vi.mock('./runtime', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('./runtime')>();
  return {
    ...original,
    getSupabaseSyncConfig: () =>
      clientHolder.client ? { client: clientHolder.client } : null,
    getSupabaseSyncUser: async () => ({ id: 'u1' }),
  };
});

/** 测试用假 Supabase client：记录 storage 调用 */
const clientHolder: { client: unknown } = { client: null };

function makeFakeClient(seedStorage: Map<string, Blob>) {
  const uploads: Array<{ path: string; blob: Blob }> = [];
  const downloads: string[] = [];
  const client = {
    auth: {
      getSession: async () => ({
        data: {
          session: { user: { id: 'u1', email: 'repro_user@yjk.com' } },
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
      from: (bucket: string) => ({
        upload: async (path: string, blob: Blob) => {
          uploads.push({ path, blob });
          seedStorage.set(path, blob);
          return { error: null };
        },
        download: async (path: string) => {
          downloads.push(path);
          const data = seedStorage.get(path) ?? null;
          return { data, error: null };
        },
      }),
    },
  };
  return { client, uploads, downloads, bucketSpy: client.storage.from };
}

/** 本地真实媒体 blob（PNG 魔数），可过 isLikelyMediaBlob 校验 */
function pngBlob(bytesText = 'repro-media-bytes'): Blob {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ...new TextEncoder().encode(bytesText),
  ]);
  const blob = new Blob([bytes], { type: 'image/png' }) as Blob & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  blob.arrayBuffer = async () => bytes.buffer.slice(0);
  return blob;
}

/** HTML 毒化 blob（dev server 兜底页特征，魔数校验应拒绝） */
function htmlBlob(): Blob {
  const bytes = new TextEncoder().encode(
    '<!DOCTYPE html><html lang="zh-CN"><head><script src="/src/main.tsx"></script></head><body></body></html>'
  );
  const blob = new Blob([bytes], { type: 'image/png' }) as Blob & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  blob.arrayBuffer = async () => bytes.buffer.slice(0);
  return blob;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('云端唯一存储：媒体二进制通道（复现测试）', () => {
  beforeEach(async () => {
    const { clearCacheBlobFallbacks } = await import(
      '../cache-blob-fallback-store'
    );
    const { unifiedCacheService } = await import(
      '../unified-cache-service'
    );
    await unifiedCacheService.deleteCache(UPLOAD_URL).catch(() => undefined);
    await unifiedCacheService.deleteCache(DOWNLOAD_URL).catch(() => undefined);
    await clearCacheBlobFallbacks();
    repoMocks.fetchRemoteMediaByUrl.mockReset();
    repoMocks.upsertRemoteMedia.mockReset();
    repoMocks.fetchRemoteMediaByUrl.mockResolvedValue({
      media: null,
      error: null,
    });
    repoMocks.upsertRemoteMedia.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('A. cacheMediaFromBlob 写入虚拟 URL 后应上传二进制到 yue-sync 并 upsert user_sync_media', async () => {
    const { unifiedCacheService } = await import(
      '../unified-cache-service'
    );
    const fake = makeFakeClient(new Map());
    clientHolder.client = fake.client;

    const blob = pngBlob('upload-channel-bytes');
    await unifiedCacheService.cacheMediaFromBlob(UPLOAD_URL, blob, 'image', {
      metadata: {},
      contentHash: 'repro-upload-hash',
    } as any);

    // 上传为 fire-and-forget：等待云通道副作用出现（修复前永远等不到 → 失败）
    await vi.waitFor(
      () => {
        expect(repoMocks.upsertRemoteMedia).toHaveBeenCalled();
      },
      { timeout: 5000, interval: 100 }
    );

    expect(fake.uploads.length).toBe(1);
    expect(fake.uploads[0]!.path).toContain('image/');
    const upsertArg = repoMocks.upsertRemoteMedia.mock.calls[0]![2] as Array<
      Record<string, unknown>
    >;
    expect(upsertArg[0]).toMatchObject({
      url: UPLOAD_URL,
      type: 'image',
      storagePath: fake.uploads[0]!.path,
    });
  });

  it('B. 本地无 blob 时 getCachedBlob 应从云端下载回填本地并返回 blob', async () => {
    const { unifiedCacheService } = await import(
      '../unified-cache-service'
    );
    const remoteBytes = pngBlob('download-channel-bytes');
    const fake = makeFakeClient(
      new Map([['u1/image/repro-download-hash.png', remoteBytes]])
    );
    clientHolder.client = fake.client;
    repoMocks.fetchRemoteMediaByUrl.mockResolvedValue({
      media: {
        url: DOWNLOAD_URL,
        type: 'image',
        mimeType: 'image/png',
        size: remoteBytes.size,
        storagePath: 'u1/image/repro-download-hash.png',
        updatedAt: Date.now(),
      },
      error: null,
    });

    const blob = await unifiedCacheService.getCachedBlob(DOWNLOAD_URL);
    expect(blob).not.toBeNull();
    expect(blob!.type.startsWith('image/')).toBe(true);
    expect(fake.downloads).toContain('u1/image/repro-download-hash.png');

    // 回填后本地已有：再次读取不再触发云端下载
    const again = await unifiedCacheService.getCachedBlob(DOWNLOAD_URL);
    expect(again).not.toBeNull();
    expect(fake.downloads.length).toBe(1);
  });
});

describe('云端唯一存储：媒体二进制通道（边界）', () => {
  beforeEach(() => {
    repoMocks.fetchRemoteMediaByUrl.mockReset();
    repoMocks.upsertRemoteMedia.mockReset();
    repoMocks.fetchRemoteMediaByUrl.mockResolvedValue({
      media: null,
      error: null,
    });
    repoMocks.upsertRemoteMedia.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('云端行哈希与本地一致 → 跳过重复上传（内容寻址去重）', async () => {
    const { uploadMediaBinaryToCloud } = await import(
      './media-binary-channel'
    );
    const fake = makeFakeClient(new Map());
    clientHolder.client = fake.client;
    const blob = pngBlob('dedupe-bytes');

    const first = await uploadMediaBinaryToCloud(
      '/asset-library/content-dedupe.png',
      blob,
      'image'
    );
    expect(first).toBe(true);
    expect(fake.uploads.length).toBe(1);
    // 用首次 upsert 的行回填远端查询 → 同 blob 再传应跳过
    const upsertRow = repoMocks.upsertRemoteMedia.mock.calls[0]![2][0] as {
      storagePath: string;
    };
    repoMocks.fetchRemoteMediaByUrl.mockResolvedValue({
      media: {
        url: '/asset-library/content-dedupe.png',
        type: 'image',
        mimeType: 'image/png',
        size: blob.size,
        storagePath: upsertRow.storagePath,
        updatedAt: Date.now(),
      },
      error: null,
    });

    const second = await uploadMediaBinaryToCloud(
      '/asset-library/content-dedupe.png',
      blob,
      'image'
    );
    expect(second).toBe(true);
    expect(fake.uploads.length).toBe(1); // 未重传
  });

  it('未登录（无同步配置）→ 上传跳过、下载不查云', async () => {
    clientHolder.client = null;
    const { uploadMediaBinaryToCloud } = await import(
      './media-binary-channel'
    );

    const uploaded = await uploadMediaBinaryToCloud(
      '/asset-library/content-nologin.png',
      pngBlob('nologin'),
      'image'
    );
    expect(uploaded).toBe(false);
    expect(repoMocks.upsertRemoteMedia).not.toHaveBeenCalled();

    const { unifiedCacheService } = await import(
      '../unified-cache-service'
    );
    const blob = await unifiedCacheService.getCachedBlob(
      '/asset-library/content-nologin.png'
    );
    expect(blob).toBeNull();
    expect(repoMocks.fetchRemoteMediaByUrl).not.toHaveBeenCalled();
  });

  it('云端无行 → 返回 null 且负缓存生效（重复轮询不打 REST）', async () => {
    const fake = makeFakeClient(new Map());
    clientHolder.client = fake.client;
    const { unifiedCacheService } = await import(
      '../unified-cache-service'
    );
    const url = '/asset-library/content-norow.png';

    expect(await unifiedCacheService.getCachedBlob(url)).toBeNull();
    expect(await unifiedCacheService.getCachedBlob(url)).toBeNull();
    expect(await unifiedCacheService.getCachedBlob(url)).toBeNull();
    expect(repoMocks.fetchRemoteMediaByUrl).toHaveBeenCalledTimes(1);
  });

  it('云端行指向毒化对象（HTML 字节）→ 拒绝返回，不污染本地', async () => {
    const poisoned = htmlBlob();
    const fake = makeFakeClient(
      new Map([['u1/image/poison.png', poisoned]])
    );
    clientHolder.client = fake.client;
    repoMocks.fetchRemoteMediaByUrl.mockResolvedValue({
      media: {
        url: '/asset-library/content-poison.png',
        type: 'image',
        mimeType: 'image/png',
        size: poisoned.size,
        storagePath: 'u1/image/poison.png',
        updatedAt: Date.now(),
      },
      error: null,
    });
    const { unifiedCacheService } = await import(
      '../unified-cache-service'
    );

    const blob = await unifiedCacheService.getCachedBlob(
      '/asset-library/content-poison.png'
    );
    expect(blob).toBeNull();
  });

  it('非虚拟 URL（外链）→ 不触发上云', async () => {
    const fake = makeFakeClient(new Map());
    clientHolder.client = fake.client;
    const { unifiedCacheService } = await import(
      '../unified-cache-service'
    );

    await unifiedCacheService
      .cacheMediaFromBlob('https://cdn.example.com/a.png', pngBlob('ext'), 'image', {
        metadata: {},
        contentHash: 'ext-hash',
      } as any)
      .catch(() => undefined);
    await sleep(600);

    expect(repoMocks.upsertRemoteMedia).not.toHaveBeenCalled();
    expect(fake.uploads.length).toBe(0);
  });
});

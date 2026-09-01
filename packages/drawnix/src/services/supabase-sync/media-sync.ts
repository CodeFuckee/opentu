/**
 * 媒体同步服务
 *
 * 把本地媒体二进制（素材库图片 / AI 生成图/视频/音频 / 画布内图片）上传到 Supabase Storage
 * 私有桶 `yue-sync`，元数据写入 user_sync_media；下载时按元数据拉取并写入 Cache。
 *
 * 关键点：
 * - 本地二进制读取复用 unifiedCacheService.getCachedBlob()（Cache Storage 是唯一真相）
 * - storage_path 形如 {sanitized-username}/{category}/{sha256}.{ext}，按内容哈希天然去重
 * - username 与 task-submissions 相同规则：user_profiles.oa_account 或邮箱 @ 前缀，
 *   与 storage 策略 storage.foldername(name)[1] 匹配
 * - 全程 fire-and-forget、静默失败：任何异常只 console.warn，绝不抛出、不阻塞主流程
 */

import type { SupabaseSyncConfig } from './types';
import type { SyncMediaItem } from './types';
import { unifiedCacheService } from '../unified-cache-service';
import { fetchRemoteMedia, upsertRemoteMedia } from './repository';
import { yieldToMain } from './checksum';

const DEFAULT_BUCKET = 'yue-sync';

/** 与 task-submissions 一致的 MIME → 扩展名映射（core 自带，这里内联精简版） */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-m4a': 'm4a',
};
const FALLBACK_EXT = 'bin';

function mimeToExtension(mime: string): string {
  return MIME_TO_EXT[mime.trim().toLowerCase()] ?? FALLBACK_EXT;
}

/** 用户名清洗（与 task-submissions sanitizeUsername 同规则） */
function sanitizeUsername(username: string): string {
  return username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .slice(0, 64);
}

/** 从媒体 URL 推断类型 */
function guessType(url: string): 'image' | 'video' | 'audio' {
  const lower = url.toLowerCase();
  if (/\.(mp4|webm|mov|m4v)$/.test(lower) || url.includes('/video/')) {
    return 'video';
  }
  if (/\.(mp3|wav|ogg|flac|m4a)$/.test(lower) || url.includes('/audio/')) {
    return 'audio';
  }
  return 'image';
}

/** 解析当前用户名（与 service.ts resolveUsername 同规则） */
async function resolveUsername(
  config: SupabaseSyncConfig
): Promise<string | null> {
  try {
    const client = config.client as {
      auth: {
        getSession: () => Promise<{
          data: { session: { user: { id: string; email?: string } | null } | null };
        }>;
      };
      from: (table: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => Promise<{ data: { oa_account?: string } | null }>;
          };
        };
      };
    };
    const { data } = await client.auth.getSession();
    const user = data.session?.user;
    if (!user) {
      return null;
    }
    try {
      const { data: profile } = await client
        .from('user_profiles')
        .select('oa_account')
        .eq('user_id', user.id)
        .maybeSingle();
      const oaAccount = profile?.oa_account;
      if (typeof oaAccount === 'string' && oaAccount.trim()) {
        return sanitizeUsername(oaAccount);
      }
    } catch {
      // 查询失败走邮箱回退
    }
    if (user.email && user.email.includes('@')) {
      const prefix = user.email.split('@')[0] ?? '';
      if (prefix.trim()) {
        return sanitizeUsername(prefix);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 本地媒体 URL 集合（素材库 + AI 生成缓存 + 画板图片虚拟路径） */
async function collectLocalMediaUrls(): Promise<string[]> {
  const urls = new Set<string>();

  // 1. 素材库元数据
  try {
    const { assetStorageService } = await import('../asset-storage-service');
    const assets = await assetStorageService.getAllAssets();
    for (const asset of assets) {
      if (asset.url) {
        urls.add(asset.url);
      }
    }
  } catch {
    // 素材库不可用（未初始化等）忽略
  }

  // 2. 统一缓存媒体（AI 生成图片/视频/音频 + 画布缓存）——只统计真正有内容的缓存
  try {
    const cached = await unifiedCacheService.getAllCacheMetadata();
    for (const item of cached) {
      // 失败缓存（fetch 404 等，cacheImage 失败时写入 size=0 + cacheWarning）不算
      // 本地媒体：计入会让 media-sync 误判「本地已有」而跳过远端下载，
      // 另一台设备上的图片将永远拿不到二进制（画布空白 + 控制台 404 刷屏）
      if (!item.url || item.size === 0 || item.metadata?.cacheWarning) {
        continue;
      }
      urls.add(item.url);
    }
  } catch {
    // 缓存不可用忽略
  }

  return Array.from(urls);
}

/**
 * 执行一次媒体同步：上传本地缺失媒体 + 下载远端缺失媒体到本地。
 * 返回统计；全程不抛出（失败记 failed）。
 */
export async function syncMediaToSupabase(
  config: SupabaseSyncConfig,
  userId: string
): Promise<{ uploaded: number; downloaded: number; failed: number }> {
  const bucketName = config.bucketName?.trim() || DEFAULT_BUCKET;
  const username = await resolveUsername(config);
  const stats = { uploaded: 0, downloaded: 0, failed: 0 };

  if (!username) {
    return stats;
  }

  // 远端媒体索引
  const { media: remoteMedia, error: fetchError } = await fetchRemoteMedia(
    config,
    userId
  );
  if (fetchError) {
    return stats;
  }
  const remoteByUrl = new Map(remoteMedia.map((m) => [m.url, m]));

  // 本地媒体索引
  const localUrls = await collectLocalMediaUrls();
  const localByUrl = new Set(localUrls);

  // --- 上传：本地有、远端无 → 上传 blob + 元数据 ---
  const toUpsert: SyncMediaItem[] = [];
  for (const url of localUrls) {
    if (remoteByUrl.has(url)) {
      continue; // 远端已有
    }
    try {
      const blob = await unifiedCacheService.getCachedBlob(url);
      if (!blob || blob.size === 0) {
        continue;
      }
      const client = config.client as {
        storage: {
          from: (bucket: string) => {
            upload: (
              path: string,
              file: Blob,
              opts: { contentType: string; upsert: boolean }
            ) => Promise<{ error: { message: string } | null }>;
          };
        };
      };
      const type = guessType(url);
      const mimeType = blob.type || 'application/octet-stream';
      const extension = mimeToExtension(mimeType);
      const hash = await sha256Hex(await blob.arrayBuffer());
      const storagePath = `${username}/${type}/${hash}.${extension}`;

      const { error } = await client.storage
        .from(bucketName)
        .upload(storagePath, blob, { contentType: mimeType, upsert: true });
      if (error) {
        stats.failed++;
        continue;
      }
      toUpsert.push({
        url,
        type,
        mimeType,
        size: blob.size,
        storagePath,
        updatedAt: Date.now(),
      });
      stats.uploaded++;
    } catch {
      stats.failed++;
    }
  }

  // --- 下载：远端有、本地无真实二进制 → 写回 Cache ---
  for (const item of remoteMedia) {
    if (localByUrl.has(item.url)) {
      // 有本地标记（素材/缓存元数据）≠ 有真实二进制：跨设备同步会先回填
      // 缓存元数据（applyRemote 的 cache_media 实体，size>0 且无 cacheWarning），
      // 若仅凭元数据跳过下载，本机将永远拿不到 blob（图片空白 + 404 刷屏）
      const existingBlob = await unifiedCacheService
        .getCachedBlob(item.url)
        .catch(() => null);
      if (existingBlob && existingBlob.size > 0) {
        continue;
      }
    }
    try {
      const client = config.client as {
        storage: {
          from: (bucket: string) => {
            download: (path: string) => Promise<{
              data: Blob | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
      const { data, error } = await client.storage
        .from(bucketName)
        .download(item.storagePath);
      if (error || !data || data.size === 0) {
        stats.failed++;
        continue;
      }
      await cacheBlobToLocal(item.url, data);
      stats.downloaded++;
    } catch {
      stats.failed++;
    }
    // 每下载若干项让出主线程
    if (stats.downloaded % 5 === 0) {
      await yieldToMain();
    }
  }

  // 写入远端缺失的媒体元数据
  if (toUpsert.length > 0) {
    const { error } = await upsertRemoteMedia(config, userId, toUpsert);
    if (error) {
      stats.failed++;
    }
  }

  return stats;
}

/** 把下载的 blob 写回本地 Cache Storage（复用 unifiedCacheService） */
async function cacheBlobToLocal(url: string, blob: Blob): Promise<void> {
  const ok = await unifiedCacheService.cacheToCacheStorageOnly(url, blob);
  if (!ok) {
    console.warn('[supabase-sync] cacheToCacheStorageOnly failed:', url);
  }
}

/** SHA-256（十六进制小写） */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('crypto.subtle is not available');
  }
  const digest = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export { collectLocalMediaUrls, resolveUsername, sanitizeUsername, mimeToExtension };
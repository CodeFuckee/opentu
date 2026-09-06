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
 * 判断远端媒体行是否需要用本地 blob 重新上传（云端对象自愈）。
 *
 * 仅对内容寻址 URL（basename 以 content- 开头，如 /asset-library/content-<hash>.png）
 * 生效：这类 URL 的二进制与其内容哈希一一对应。media-sync 上传的 storage_path 恒为
 * {username}/{type}/{sha256(blob)}.{ext}，若行内哈希与本地 blob 的 sha256 不一致，
 * 说明云端对象是过期/毒化数据（如历史版本把 HTML 兜底页当图片上传），需重传覆盖，
 * 否则另一台设备永远下载到错误字节（图片空白）。
 */
async function shouldHealRemoteMedia(
  url: string,
  remoteStoragePath: string,
  localHash: string
): Promise<boolean> {
  const urlName = url.split('/').pop() ?? '';
  if (!urlName.startsWith('content-')) {
    return false;
  }
  const remoteBasename = (remoteStoragePath || '').split('/').pop() ?? '';
  const remoteHash = remoteBasename.split('.')[0] ?? '';
  return remoteHash !== localHash;
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
  // utils 库按 Nx 规则为懒加载（lint 禁止静态 import），此处按需动态加载媒体特征校验
  const { isLikelyMediaBlob } = await import('@aitu/utils');

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

  // --- 上传：本地有、远端无（或云端对象已毒化）→ 上传 blob + 元数据 ---
  const toUpsert: SyncMediaItem[] = [];
  for (const url of localUrls) {
    try {
      const blob = await unifiedCacheService.getCachedBlob(url);
      if (!blob || blob.size === 0) {
        continue;
      }
      // 非媒体本地 blob（如 dev server 的 200 HTML 兜底页被误缓存）不上传，
      // 避免把毒化数据传播到云端
      if (!(await isLikelyMediaBlob(blob))) {
        continue;
      }
      const hash = await sha256Hex(await blob.arrayBuffer());
      const remote = remoteByUrl.get(url);
      if (remote && !(await shouldHealRemoteMedia(url, remote.storagePath, hash))) {
        continue; // 远端已有且内容与本地一致
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
      // 本地 blob 必须既是真实媒体（排除被误缓存的 HTML 兜底页等毒化数据）
      // 才会跳过下载——毒化 blob 存在时仍要下载真实二进制覆盖它
      if (
        existingBlob &&
        existingBlob.size > 0 &&
        (await isLikelyMediaBlob(existingBlob))
      ) {
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
      // 下载到的字节必须是真实媒体：云端的 media 行可能指向被毒化的对象
      // （历史版本曾把 HTML 错误页当图片上传），直接缓存会污染本机 Cache，
      // 使 <img> 解码失败且永远无法自愈
      if (
        error ||
        !data ||
        data.size === 0 ||
        !(await isLikelyMediaBlob(data))
      ) {
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
  if (subtle) {
    const digest = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  // 非安全上下文无 crypto.subtle：确定性 FNV-1a 摘要兜底（仅内容寻址用）
  const bytes = new Uint8Array(data);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 = (h1 ^ bytes[i]) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ bytes[i]) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const hex = (v: number) => v.toString(16).padStart(8, '0');
  return `fnv${bytes.length.toString(16)}${hex(h1)}${hex(h2)}`;
}

export { collectLocalMediaUrls, resolveUsername, sanitizeUsername, mimeToExtension };
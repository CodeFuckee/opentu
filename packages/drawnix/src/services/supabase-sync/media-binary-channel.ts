/**
 * 云端媒体二进制通道（openspec remove-local-persistence 媒体层配套）
 *
 * 背景（2026-11-23 生产实证）：云端唯一存储默认开启后 reconcileFull 一律拒绝，
 * 而媒体二进制的上传/下载（user_sync_media + yue-sync 桶）原本只存在于
 * reconcileFull 内 —— addAsset 落库的虚拟 URL 图片字节只留在上传浏览器的
 * IndexedDB 兜底库，其他浏览器只有元数据：画布图片空白 + /asset-library/ 404
 * 刷屏 + getImageForAI 报 "Virtual URL not found in cache"。
 *
 * 本模块补齐云直写链路的二进制通道（与 media-sync 同一套 yue-sync +
 * user_sync_media 语义，storage_path 同规则 {username}/{type}/{hash}.{ext}，
 * 按内容哈希天然去重、云端对象毒化自愈）：
 * - uploadMediaBinaryToCloud：虚拟 URL 媒体落本地后即上云（fire-and-forget，
 *   未登录 / 非虚拟 URL / 超限 / 非媒体字节一律静默跳过，绝不抛出）
 * - fetchMediaBlobFromCloud：本地无二进制时按 URL 查行下载（魔数校验防毒化）
 *
 * 注意：本模块不得 import unified-cache-service（它被其静态引用，避免环）。
 */

import type { SupabaseSyncConfig, SyncMediaItem } from './types';
import { fetchRemoteMediaByUrl, upsertRemoteMedia } from './repository';
import { getSupabaseSyncConfig, getSupabaseSyncUser } from './runtime';
import { isVirtualMediaUrl } from '../../utils/virtual-media-url';

/** 与 media-sync 一致的上传大小上限 */
const MAX_MEDIA_SIZE = 50 * 1024 * 1024;

/** 与 media-sync / task-submissions 一致的 MIME → 扩展名映射（精简版） */
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

/** 用户名清洗（与 media-sync sanitizeUsername 同规则） */
function sanitizeUsername(username: string): string {
  return username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .slice(0, 64);
}

function emailPrefix(email: string | undefined): string {
  return (email?.split('@')[0] ?? '').trim();
}

/** 解析当前用户名（与 media-sync resolveUsername 同规则：oa_account 优先，邮箱前缀兜底） */
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
    const prefix = emailPrefix(user.email);
    if (prefix) {
      return sanitizeUsername(prefix);
    }
    return null;
  } catch {
    return null;
  }
}

/** SHA-256（十六进制小写）；非安全上下文无 crypto.subtle 时 FNV-1a 兜底（与 media-sync 同格式） */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    // 防御性归一化：jsdom/测试环境下 data 可能来自另一 realm 的 ArrayBuffer，
    // Node webcrypto 的 instanceof 校验会拒绝——包一层当前 realm 的 Uint8Array
    // 视图（按内部槽校验，跨 realm 安全；生产单 realm 无影响）
    const digest = await subtle.digest('SHA-256', new Uint8Array(data));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
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

/** 从媒体 URL 推断类型（与 media-sync guessType 同规则，仅在调用方缺类型时用） */
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

interface StorageUploadClient {
  storage: {
    from: (bucket: string) => {
      upload: (
        path: string,
        file: Blob,
        opts: { contentType: string; upsert: boolean }
      ) => Promise<{ error: { message: string } | null }>;
    };
  };
}

interface StorageDownloadClient {
  storage: {
    from: (bucket: string) => {
      download: (path: string) => Promise<{
        data: Blob | null;
        error: { message: string } | null;
      }>;
    };
  };
}

/**
 * 上传单个虚拟 URL 媒体二进制到云端（yue-sync + user_sync_media）。
 * 一切不满足条件的情况静默跳过并返回 false；任何异常只 console.warn，绝不抛出。
 */
export async function uploadMediaBinaryToCloud(
  url: string,
  blob: Blob,
  mediaType?: 'image' | 'video' | 'audio'
): Promise<boolean> {
  try {
    if (!url || !isVirtualMediaUrl(url)) {
      return false;
    }
    if (!blob || blob.size === 0 || blob.size > MAX_MEDIA_SIZE) {
      return false;
    }
    const config = getSupabaseSyncConfig();
    if (!config) {
      return false; // 未登录 / 宿主未接同步
    }
    const user = await getSupabaseSyncUser(config);
    if (!user) {
      return false;
    }
    // 非媒体本地 blob（如 dev server 的 200 HTML 兜底页被误缓存）不上传，
    // 避免把毒化数据传播到云端（与 media-sync 上传侧防护一致）
    const { isLikelyMediaBlob } = await import('@aitu/utils');
    if (!(await isLikelyMediaBlob(blob))) {
      return false;
    }
    const username = await resolveUsername(config);
    if (!username) {
      return false;
    }

    const type = mediaType ?? guessType(url);
    const hash = await sha256Hex(await blob.arrayBuffer());
    const { media: remote, error: rowError } = await fetchRemoteMediaByUrl(
      config,
      user.id,
      url
    );
    if (rowError) {
      return false;
    }
    if (remote) {
      // 内容寻址 URL（basename 以 content- 开头）云端行哈希一致 → 已上云，跳过；
      // 不一致 → 云端对象毒化/过期，重传覆盖（自愈）。非内容寻址 URL 已有行不覆盖。
      const urlName = url.split('/').pop() ?? '';
      const remoteHash =
        (remote.storagePath || '').split('/').pop()?.split('.')[0] ?? '';
      if (!urlName.startsWith('content-') || remoteHash === hash) {
        return true;
      }
    }

    const mimeType = blob.type || 'application/octet-stream';
    const bucketName = config.bucketName?.trim() || 'yue-sync';
    const storagePath = `${username}/${type}/${hash}.${mimeToExtension(mimeType)}`;
    const client = config.client as StorageUploadClient;
    const { error } = await client.storage
      .from(bucketName)
      .upload(storagePath, blob, { contentType: mimeType, upsert: true });
    if (error) {
      console.warn(
        '[MediaBinaryChannel] 二进制上传失败:',
        url,
        error.message
      );
      return false;
    }

    const item: SyncMediaItem = {
      url,
      type,
      mimeType,
      size: blob.size,
      storagePath,
      updatedAt: Date.now(),
    };
    const { error: upsertError } = await upsertRemoteMedia(config, user.id, [
      item,
    ]);
    if (upsertError) {
      console.warn('[MediaBinaryChannel] 媒体元数据 upsert 失败:', url);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[MediaBinaryChannel] 上传异常:', url, error);
    return false;
  }
}

/**
 * 从云端下载指定虚拟 URL 的媒体二进制（按 user_sync_media 行）。
 * 无行 / 下载失败 / 字节非媒体（毒化行防护）一律返回 null，绝不抛出。
 */
export async function fetchMediaBlobFromCloud(
  url: string
): Promise<Blob | null> {
  try {
    if (!url || !isVirtualMediaUrl(url)) {
      return null;
    }
    const config = getSupabaseSyncConfig();
    if (!config) {
      return null;
    }
    const user = await getSupabaseSyncUser(config);
    if (!user) {
      return null;
    }
    const { media: row, error } = await fetchRemoteMediaByUrl(
      config,
      user.id,
      url
    );
    if (error || !row || !row.storagePath) {
      return null;
    }
    const bucketName = config.bucketName?.trim() || 'yue-sync';
    const client = config.client as StorageDownloadClient;
    const { data, error: dlError } = await client.storage
      .from(bucketName)
      .download(row.storagePath);
    if (dlError || !data || data.size === 0) {
      return null;
    }
    // 云端的 media 行可能指向被毒化的对象（历史版本曾把 HTML 错误页当图片上传），
    // 直接缓存会污染本机兜底库且 <img> 解码失败无法自愈（与 media-sync 下载侧防护一致）
    const { isLikelyMediaBlob } = await import('@aitu/utils');
    if (!(await isLikelyMediaBlob(data))) {
      return null;
    }
    if (row.mimeType && (!data.type || data.type === 'application/octet-stream')) {
      return new Blob([data], { type: row.mimeType });
    }
    return data;
  } catch {
    return null;
  }
}

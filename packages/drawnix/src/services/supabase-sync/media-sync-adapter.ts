/**
 * 媒体同步状态适配层
 *
 * 提供与 github-sync/media-sync-service 相同的最小接口面（素材库/任务队列复用 UI 不变），
 * 底层指向 supabase-sync 的媒体同步实现：
 * - getRemoteSyncedUrls: user_sync_media 表中已同步的 URL 集合
 * - getUrlSyncStatus: 单 URL 同步状态（基于内存缓存集合）
 * - syncSelectedMedia: 上传指定 URL 到 Storage + 写元数据
 * - addSyncCompletedListener / removeSyncCompletedListener: 同步完成事件
 */

import type { SupabaseSyncConfig } from './types';
import { getSupabaseSyncConfig } from './runtime';
import { fetchRemoteMedia, upsertRemoteMedia } from './repository';
import { unifiedCacheService } from '../unified-cache-service';
import type { SyncMediaItem } from './types';
import { logDebug, logWarning } from './log';

export type MediaSyncStatus = 'not_synced' | 'synced' | 'syncing' | 'too_large' | 'error';

export interface MediaItemSyncResult {
  success: boolean;
  url: string;
  error?: string;
  size?: number;
}

export interface BatchMediaItemSyncResult {
  succeeded: number;
  failed: number;
  skipped: number;
  results: MediaItemSyncResult[];
  totalSize: number;
  duration: number;
}

type SyncCompletedCallback = (result: BatchMediaItemSyncResult) => void;

const DEFAULT_BUCKET = 'yue-sync';

/** MIME → 扩展名（与 media-sync 同规则） */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-m4a': 'm4a',
};
const FALLBACK_EXT = 'bin';

const MAX_MEDIA_SIZE = 50 * 1024 * 1024;

class MediaSyncAdapter {
  private listeners = new Set<SyncCompletedCallback>();

  /** 已同步 URL 的内存缓存 */
  private syncedUrls = new Set<string>();
  private statusCacheLoaded = false;

  addSyncCompletedListener(callback: SyncCompletedCallback): void {
    this.listeners.add(callback);
  }

  removeSyncCompletedListener(callback: SyncCompletedCallback): void {
    this.listeners.delete(callback);
  }

  private notifySyncCompleted(result: BatchMediaItemSyncResult): void {
    for (const listener of this.listeners) {
      try {
        listener(result);
      } catch {
        // 监听器异常不阻塞
      }
    }
  }

  /** 加载已同步 URL 缓存（一次） */
  private async ensureStatusCache(): Promise<void> {
    if (this.statusCacheLoaded) {
      return;
    }
    const config = getSupabaseSyncConfig();
    if (!config) {
      return;
    }
    const userId = await this.getUserId(config);
    if (!userId) {
      return;
    }
    const { media } = await fetchRemoteMedia(config, userId);
    this.syncedUrls = new Set(media.map((m) => m.url));
    this.statusCacheLoaded = true;
  }

  private async getUserId(config: SupabaseSyncConfig): Promise<string | null> {
    try {
      const client = config.client as {
        auth: {
          getSession: () => Promise<{
            data: { session: { user: { id: string } | null } | null };
          }>;
        };
      };
      const { data } = await client.auth.getSession();
      return data.session?.user?.id ?? null;
    } catch {
      return null;
    }
  }

  /** 刷新已同步 URL 集合（登录后/同步后调用） */
  async refreshSyncStatus(): Promise<void> {
    this.statusCacheLoaded = false;
    await this.ensureStatusCache();
  }

  /** 获取单 URL 同步状态 */
  getUrlSyncStatus(url: string): MediaSyncStatus {
    return this.syncedUrls.has(url) ? 'synced' : 'not_synced';
  }

  /** 获取远程已同步的 URL 集合 */
  async getRemoteSyncedUrls(): Promise<Set<string>> {
    await this.ensureStatusCache();
    return new Set(this.syncedUrls);
  }

  /** 同步选中媒体（上传到 Storage + 写元数据） */
  async syncSelectedMedia(
    urls: string[],
    onProgress?: (current: number, total: number, url: string, status: 'uploading' | 'downloading' | 'caching') => void
  ): Promise<BatchMediaItemSyncResult> {
    const startTime = Date.now();
    const config = getSupabaseSyncConfig();
    if (!config) {
      return {
        succeeded: 0,
        failed: 0,
        skipped: 0,
        results: [],
        totalSize: 0,
        duration: Date.now() - startTime,
      };
    }

    const userId = await this.getUserId(config);
    if (!userId) {
      return {
        succeeded: 0,
        failed: 0,
        skipped: 0,
        results: [],
        totalSize: 0,
        duration: Date.now() - startTime,
      };
    }

    const bucketName = config.bucketName?.trim() || DEFAULT_BUCKET;
    const username = await this.resolveUsername(config);
    const results: MediaItemSyncResult[] = [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let totalSize = 0;

    const remoteByUrl = new Map<string, SyncMediaItem>();
    const { media } = await fetchRemoteMedia(config, userId);
    for (const m of media) {
      remoteByUrl.set(m.url, m);
    }

    const upsertItems: SyncMediaItem[] = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      onProgress?.(i + 1, urls.length, url, 'uploading');
      try {
        if (remoteByUrl.has(url)) {
          skipped++;
          results.push({ success: true, url, error: '已同步' });
          continue;
        }
        const blob = await unifiedCacheService.getCachedBlob(url);
        if (!blob || blob.size === 0) {
          skipped++;
          results.push({ success: false, url, error: '本地无缓存' });
          continue;
        }
        if (blob.size > MAX_MEDIA_SIZE) {
          skipped++;
          results.push({ success: false, url, error: '文件过大' });
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
        const type = this.guessType(url);
        const mimeType = blob.type || 'application/octet-stream';
        const extension = MIME_TO_EXT[mimeType.trim().toLowerCase()] ?? FALLBACK_EXT;
        const hash = await this.sha256Hex(await blob.arrayBuffer());
        const storagePath = username
          ? `${username}/${type}/${hash}.${extension}`
          : `${type}/${hash}.${extension}`;

        const { error } = await client.storage
          .from(bucketName)
          .upload(storagePath, blob, { contentType: mimeType, upsert: true });
        if (error) {
          failed++;
          results.push({ success: false, url, error: error.message });
          continue;
        }
        upsertItems.push({
          url,
          type,
          mimeType,
          size: blob.size,
          storagePath,
          updatedAt: Date.now(),
        });
        totalSize += blob.size;
        succeeded++;
        results.push({ success: true, url, size: blob.size });
      } catch (err) {
        failed++;
        results.push({
          success: false,
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (upsertItems.length > 0) {
      const { error } = await upsertRemoteMedia(config, userId, upsertItems);
      if (error) {
        logWarning('upsert media failed', { error: String(error) });
      }
    }

    const result: BatchMediaItemSyncResult = {
      succeeded,
      failed,
      skipped,
      results,
      totalSize,
      duration: Date.now() - startTime,
    };
    this.notifySyncCompleted(result);
    return result;
  }

  /** 解析用户名（与 media-sync 同规则） */
  private async resolveUsername(config: SupabaseSyncConfig): Promise<string | null> {
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
        if (typeof profile?.oa_account === 'string' && profile.oa_account.trim()) {
          return this.sanitizeUsername(profile.oa_account);
        }
      } catch {
        // 查询失败走邮箱回退
      }
      if (user.email && user.email.includes('@')) {
        const prefix = user.email.split('@')[0] ?? '';
        if (prefix.trim()) {
          return this.sanitizeUsername(prefix);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private sanitizeUsername(username: string): string {
    return username
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_')
      .slice(0, 64);
  }

  private guessType(url: string): 'image' | 'video' | 'audio' {
    const lower = url.toLowerCase();
    if (/\.(mp4|webm|mov|m4v)$/.test(lower) || url.includes('/video/')) {
      return 'video';
    }
    if (/\.(mp3|wav|ogg|flac|m4a)$/.test(lower) || url.includes('/audio/')) {
      return 'audio';
    }
    return 'image';
  }

  private async sha256Hex(data: ArrayBuffer): Promise<string> {
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

  /** 兼容：批量任务媒体同步（等价调用 syncSelectedMedia） */
  async syncMultipleTasks(
    _taskIds: string[],
    onProgress?: (current: number, total: number, url: string, status: 'uploading' | 'downloading' | 'caching') => void
  ): Promise<BatchMediaItemSyncResult> {
    logDebug('syncMultipleTasks: task-level media sync is handled by whole-sync flow', {
      taskIds: _taskIds.length,
    });
    // 任务级同步在完整同步（syncMediaToSupabase）中自动执行；这里返回空成功
    return {
      succeeded: 0,
      failed: 0,
      skipped: 0,
      results: [],
      totalSize: 0,
      duration: 0,
    };
  }
}

export const mediaSyncAdapter = new MediaSyncAdapter();
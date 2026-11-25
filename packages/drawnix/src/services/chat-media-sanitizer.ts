/**
 * 聊天消息落库媒体消毒（2026-11-25 生产事故修复）
 *
 * 事故：workflow/聊天消息把参考图以 base64 data URL 原样存进
 * chat_message（parts / attachments[].data / aiContext.selection.images /
 * workflow.steps[].args.referenceImages / retryContext.referenceImages），
 * 单行最大 135MB、单账号累计 2.8GB——聊天拉取 PostgREST 序列化 1.87GB 必然
 * 500，渲染进程灌入巨型行后内存耗尽崩溃（STATUS_BREAKPOINT）。
 *
 * 本守卫在消息落库前深遍历整个消息对象：凡 ≥ CHAT_INLINE_DATAURL_MAX_BYTES
 * 的 data:image|video|audio base64，转 Blob 后经 cacheLocalMediaByContent
 * 归档为内容寻址虚拟 URL（同时触发媒体二进制通道上云），原位替换。
 * 归档失败保留原 data URL 并告警——绝不阻塞消息保存。
 * 小于阈值的内联 data URL（小图标等）保持原样。
 */

import { dataUrlToBlob } from '@aitu/utils';
import type { ChatMessage } from '../types/chat.types';
import { unifiedCacheService } from './unified-cache-service';

/** 内联 base64 体积阈值：超过则归档为虚拟 URL */
export const CHAT_INLINE_DATAURL_MAX_BYTES = 512 * 1024;

/** data URL 识别（仅媒体三类；捕获 mime 主类型用于归档分类） */
const MEDIA_DATA_URL_RE = /^data:(image|video|audio)\/[^;,]+;base64,/i;

type MediaKind = 'image' | 'video' | 'audio';

function isMediaDataUrl(value: string): { kind: MediaKind } | null {
  const match = MEDIA_DATA_URL_RE.exec(value);
  if (!match) return null;
  return { kind: match[1].toLowerCase() as MediaKind };
}

export interface ChatMediaSanitizeStats {
  /** 归档替换的 data URL 个数 */
  archived: number;
  /** 归档失败保留原样的个数 */
  failed: number;
  /** 原样保留的小于阈值 data URL 个数 */
  keptInline: number;
}

/**
 * 深遍历消息对象，把超过阈值的媒体 data URL 归档为内容寻址虚拟 URL。
 * 返回新对象（不修改入参）与统计。同一 data URL 只归档一次（内容寻址
 * 本身幂等，缓存映射仅为省 CPU）。
 */
export async function sanitizeChatMessageForSave(
  message: ChatMessage
): Promise<{ message: ChatMessage; stats: ChatMediaSanitizeStats }> {
  const stats: ChatMediaSanitizeStats = {
    archived: 0,
    failed: 0,
    keptInline: 0,
  };
  const archiveCache = new Map<string, string>();

  // 两阶段处理（确定性强，避免并发遍历时同一 URL 重复归档）：
  // ① 同步收集全部待归档的媒体 data URL（去重）；
  // ② 逐个归档建映射；③ 同步遍历按映射原位替换。
  const pending = new Set<string>();
  const keptInlineSet = new Set<string>();
  const collect = (node: unknown): void => {
    if (typeof node === 'string') {
      const media = isMediaDataUrl(node);
      if (!media) {
        return;
      }
      if (node.length < CHAT_INLINE_DATAURL_MAX_BYTES) {
        keptInlineSet.add(node);
      } else {
        pending.add(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) {
        collect(value);
      }
    }
  };
  collect(message);
  stats.keptInline = keptInlineSet.size;

  for (const dataUrl of pending) {
    const media = isMediaDataUrl(dataUrl)!;
    try {
      const blob = dataUrlToBlob(dataUrl);
      const { url } = await unifiedCacheService.cacheLocalMediaByContent(
        blob,
        media.kind
      );
      if (url && url !== dataUrl) {
        archiveCache.set(dataUrl, url);
        stats.archived += 1;
      } else {
        archiveCache.set(dataUrl, dataUrl);
        stats.failed += 1;
      }
    } catch (error) {
      console.warn(
        '[ChatMediaSanitizer] data URL 归档失败（保留原样）:',
        `${dataUrl.slice(0, 48)}…`,
        error
      );
      archiveCache.set(dataUrl, dataUrl);
      stats.failed += 1;
    }
  }

  const replace = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return archiveCache.get(node) ?? node;
    }
    if (Array.isArray(node)) {
      return node.map(replace);
    }
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([key, value]) => [
          key,
          replace(value),
        ])
      );
    }
    return node;
  };

  const sanitized = (await Promise.resolve(replace(message))) as ChatMessage;
  return { message: sanitized, stats };
}

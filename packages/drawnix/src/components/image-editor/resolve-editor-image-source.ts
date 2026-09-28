/**
 * 图片编辑器的图片源解析(非安全上下文降级)。
 *
 * 背景:画布图片元素的 url 可能是虚拟路径(/__aitu_cache__/...),该路径只有
 * Service Worker 能拦截服务;纯 HTTP 内网(非安全上下文)不存在 SW API,
 * 直接 new Image() 或 img.src 指向虚拟 URL 必然发网络请求 → 404 →「图片加载失败」。
 * 显示组件 RetryImage 已有同款降级,编辑器经此 helper 对齐。
 */
import { isVirtualMediaUrl } from '../../utils/virtual-media-url';
import { unifiedCacheService } from '../../services/unified-cache-service';

export interface ResolvedEditorImageSource {
  /** 实际用于加载/展示的源(可能是 blob: URL) */
  src: string;
  /** 降级创建的 objectURL;非 null 时调用方卸载时须 revokeObjectURL */
  objectUrl: string | null;
}

function hasServiceWorkerAPI(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * 解析编辑器应加载的图片源:
 * - 虚拟 URL 且无 SW API(纯 HTTP 内网)→ 从缓存 blob(含 IndexedDB 兜底)
 *   解析出 objectURL;缓存 miss 时原样返回(由加载方 onerror 报错,行为同旧);
 * - 其余(SW 可用 / data: / blob: / 普通外部与桶直链)→ 原样返回,零开销。
 */
export async function resolveEditorImageSource(
  imageUrl: string
): Promise<ResolvedEditorImageSource> {
  if (!isVirtualMediaUrl(imageUrl) || hasServiceWorkerAPI()) {
    return { src: imageUrl, objectUrl: null };
  }
  try {
    const blob = await unifiedCacheService.getCachedBlob(imageUrl);
    if (blob && blob.size > 0) {
      const objectUrl = URL.createObjectURL(blob);
      return { src: objectUrl, objectUrl };
    }
  } catch (error) {
    console.warn(
      '[ImageEditor] virtual URL fallback resolve failed:',
      imageUrl,
      error
    );
  }
  return { src: imageUrl, objectUrl: null };
}

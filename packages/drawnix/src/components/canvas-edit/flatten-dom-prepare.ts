/**
 * #103 拍平前置:虚拟 URL 图片 DOM src 临时内联为 dataURL。
 *
 * 背景(用户实测 bug,2026-09-30):内网 HTTP 无 SW,toImage 序列化渲染时
 * 虚拟路径(/__aitu_cache__/、/asset-library/)fetch 落服务器 404,safeToImage
 * 将其替换为透明 PNG 占位——拍平结果丢失原图、只剩 http 直链叠加素材。
 * 修法:渲染前把虚拟 src(含 svg image 的 href)从缓存 blob 解析成 dataURL
 * 临时替换,渲染后恢复原值;缓存 miss/抛错保持原样(退化为现状,不中断)。
 */
import { isVirtualMediaUrl } from '../../utils/virtual-media-url';
import { unifiedCacheService } from '../../services/unified-cache-service';

const URL_ATTRIBUTES = ['src', 'href', 'xlink:href'] as const;

/** 该 URL 形态需要内联(虚拟路径 / blob:)——http(s)/data: 直连即可 */
export function isInlineableUrl(url: string): boolean {
  return isVirtualMediaUrl(url) || url.startsWith('blob:');
}

/**
 * blob: URL → dataURL:经 <img> 加载后画 canvas(img-src 不受 connect-src 限制,
 * 绕开 CSP 对 fetch(blob:) 的封锁)。加载失败返回 null。
 */
export function blobUrlToDataUrl(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 1;
        canvas.height = img.naturalHeight || 1;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('blob 读取失败'));
    reader.readAsDataURL(blob);
  });
}

async function resolveVirtualToDataUrl(url: string): Promise<string | null> {
  try {
    const blob = await unifiedCacheService.getCachedBlob(url);
    if (blob && blob.size > 0) {
      return await blobToDataUrl(blob);
    }
  } catch (error) {
    console.warn('[CanvasEdit] 虚拟 URL 内联解析失败(保持原样):', url, error);
  }
  return null;
}

/**
 * 把节点集内所有虚拟 URL 图片属性临时替换为 dataURL。
 * 返回恢复函数;任何解析失败都保留原值,绝不抛出。
 */
export async function inlineVirtualImageSrcs(
  nodes: Element[]
): Promise<() => void> {
  const restores: Array<() => void> = [];
  for (const root of nodes) {
    const candidates = [
      root,
      ...Array.from(root.querySelectorAll('img, image')),
    ];
    for (const node of candidates) {
      for (const attr of URL_ATTRIBUTES) {
        const value = node.getAttribute(attr);
        if (!value || !isInlineableUrl(value)) {
          continue;
        }
        const dataUrl = value.startsWith('blob:')
          ? await blobUrlToDataUrl(value)
          : await resolveVirtualToDataUrl(value);
        if (dataUrl) {
          node.setAttribute(attr, dataUrl);
          restores.push(() => node.setAttribute(attr, value));
        }
      }
    }
  }
  return () => {
    for (const restore of restores) {
      restore();
    }
  };
}

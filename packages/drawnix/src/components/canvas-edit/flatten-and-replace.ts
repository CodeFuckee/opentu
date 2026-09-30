/**
 * #103 画布即编辑器:拍平与替换(docs/canvas-edit-mode-design.md)。
 *
 * boardToImage 渲染 [目标图+叠加] 包围盒(padding 0)→ 按原图矩形在包围盒中的
 * 相对位置裁剪(canvas)→ 上传 ai-outputs 桶拿直链(#32 插入视角同链路)→
 * 删原图+叠加、原位原尺寸插入合并图。上传失败回退 dataURL 直插(功能不中断,
 * 仅不落桶)。返回是否成功(异常向上抛由调用方决定保持编辑态)。
 */
import type { PlaitBoard, PlaitElement } from '@plait/core';
import { CoreTransforms } from '@plait/core';
import { boardToImage } from '../../utils/common';
import { insertImageFromUrl } from '../../data/image';
import { inlineVirtualImageSrcs } from './flatten-dom-prepare';
import {
  computeCropWindow,
  elementRect,
  hasOpaquePixels,
  type EditRect,
} from './canvas-edit-utils';


function unionRects(rects: EditRect[]): EditRect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: x1 - x, height: y1 - y };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('合并渲染图加载失败'));
    img.src = src;
  });
}

/** 按裁剪窗口从渲染图裁出原图区域(超出部分丢弃) */
function cropDataUrl(
  image: HTMLImageElement,
  crop: { sx: number; sy: number; sw: number; sh: number }
): string {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(crop.sw));
  canvas.height = Math.max(1, Math.round(crop.sh));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas 2d context unavailable');
  }
  ctx.drawImage(
    image,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    canvas.width,
    canvas.height
  );
  return canvas.toDataURL('image/png');
}

/** 上传 ai-outputs 桶拿公开直链;未登录/失败返回 null(调用方回退 dataURL) */
async function uploadToBucket(dataUrl: string): Promise<string | null> {
  try {
    const { ensureGeneratedMediaArchive } = await import(
      '../../services/task-supabase-archive/service'
    );
    const entries = await ensureGeneratedMediaArchive(
      `canvas-edit-${Date.now()}`,
      [dataUrl],
      30_000
    );
    return entries?.find((e) => e.sourceUrl === dataUrl && e.publicUrl)?.publicUrl ?? null;
  } catch (error) {
    console.warn('[CanvasEdit] 合并图上传桶失败,回退 dataURL 插入:', error);
    return null;
  }
}

/**
 * 拍平并替换:成功返回 true(已删除原元素并插入合并图);渲染/裁剪失败抛出
 * (调用方保持编辑态)。上传桶失败不视为失败(回退 dataURL)。
 */
export async function flattenAndReplace(
  board: PlaitBoard,
  target: PlaitElement,
  overlays: PlaitElement[]
): Promise<boolean> {
  const targetRect = elementRect(target);
  const elements = [target, ...overlays];
  // 虚拟 URL 图片(本地上传/AI 生成稳定地址)在 toImage 序列化渲染中会因
  // 内网 HTTP 无 SW 而 404→透明占位(用户实测丢原图)——渲染前临时把虚拟
  // src 内联为缓存 blob 的 dataURL,渲染后恢复(flatten-dom-prepare)
  // 虚拟 URL 图片(本地上传/AI 生成稳定地址)在 toImage 序列化渲染中会因
  // 内网 HTTP 无 SW 而 404→透明占位(用户实测丢原图)——渲染前对整个视口做
  // 虚拟 src 内联(按 [plait-data-id] 元素级收集曾在真机上未命中,这里放宽到
  // viewport 全量,目标图必在其中,渲染后恢复;flatten-dom-prepare)
  const viewport = document.querySelector('.viewport-container');
  const restoreSrcs = await inlineVirtualImageSrcs(viewport ? [viewport] : []);
  let rendered: string | undefined;
  try {
    rendered = await boardToImage(board, {
      elements,
      padding: 0,
      fillStyle: 'transparent',
    });
  } finally {
    restoreSrcs();
  }
  if (!rendered) {
    throw new Error('画布渲染为空');
  }
  const image = await loadImage(rendered);
  const union = unionRects(elements.map((el) => elementRect(el)));
  const crop = computeCropWindow(targetRect, union, {
    width: image.naturalWidth,
    height: image.naturalHeight,
  });
  let croppedDataUrl = cropDataUrl(image, crop);
  // 兜底(用户实测丢原图的第二道防线):渲染结果全透明=原图在序列化中丢失,
  // 直接以目标图自身位图作为合并结果(叠加丢失但原图保住,且留下醒目日志)
  if (!renderHasOpaquePixels(image)) {
    console.warn(
      '[CanvasEdit] 拍平渲染结果全透明(原图丢失),回退原图位图——请反馈此日志'
    );
    const fallback = await resolveOriginalImage(String((target as { url?: unknown }).url ?? ''));
    if (fallback) {
      croppedDataUrl = fallback;
    }
  }
  const finalUrl =
    (await uploadToBucket(croppedDataUrl)) ?? croppedDataUrl;

  CoreTransforms.removeElements(board, elements);
  await insertImageFromUrl(
    board,
    finalUrl,
    [targetRect.x, targetRect.y],
    false,
    { width: targetRect.width, height: targetRect.height },
    true,
    true,
    true,
    true
  );
  return true;
}


/** 渲染结果是否含不透明像素(全透明=丢原图形态) */
function renderHasOpaquePixels(image: HTMLImageElement): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, image.naturalWidth);
  canvas.height = Math.max(1, image.naturalHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return true; // 无法检测时按"有内容"处理,不触发兜底
  }
  ctx.drawImage(image, 0, 0);
  try {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return hasOpaquePixels(data);
  } catch {
    return true;
  }
}

/** 目标图位图回退:虚拟 URL→缓存 blob→dataURL;http→fetch→blob→dataURL */
async function resolveOriginalImage(url: string): Promise<string | null> {
  if (!url || url.startsWith('data:')) {
    return url.startsWith('data:') ? url : null;
  }
  try {
    const { unifiedCacheService } = await import(
      '../../services/unified-cache-service'
    );
    let blob = await unifiedCacheService.getCachedBlob(url);
    if (!blob && (url.startsWith('http://') || url.startsWith('https://'))) {
      const res = await fetch(url);
      if (res.ok) {
        blob = await res.blob();
      }
    }
    if (blob && blob.size > 0) {
      const { blobToDataUrl } = await import('./flatten-dom-prepare');
      return await blobToDataUrl(blob);
    }
  } catch (error) {
    console.warn('[CanvasEdit] 原图位图回退解析失败:', error);
  }
  return null;
}

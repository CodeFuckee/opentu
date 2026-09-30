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
import {
  computeCropWindow,
  elementRect,
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

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, base64] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/png';
  const bin = atob(base64 ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
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
  const rendered = await boardToImage(board, {
    elements,
    padding: 0,
    fillStyle: 'transparent',
  });
  if (!rendered) {
    throw new Error('画布渲染为空');
  }
  const image = await loadImage(rendered);
  const union = unionRects(elements.map((el) => elementRect(el)));
  const crop = computeCropWindow(targetRect, union, {
    width: image.naturalWidth,
    height: image.naturalHeight,
  });
  const croppedDataUrl = cropDataUrl(image, crop);
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

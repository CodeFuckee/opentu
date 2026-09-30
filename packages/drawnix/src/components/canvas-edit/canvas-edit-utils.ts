/**
 * #103 画布即编辑器:纯函数层(docs/canvas-edit-mode-design.md)。
 *
 * 会话新增判定 / 拍平白名单(新增∧与目标图相交∧仍存在)/ 裁剪窗口数学 /
 * 撤销快照。全部纯计算,不触 board副作用,单测见 canvas-edit-utils.test.ts。
 */
import { RectangleClient, type PlaitElement } from '@plait/core';

export interface EditRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 会话新增 = 当前元素 id 集合 - 进入编辑态时的集合(撤销掉的新增自然消失) */
export function computeSessionAddedIds(
  beforeIds: Set<string>,
  currentIds: Set<string>
): Set<string> {
  const added = new Set<string>();
  for (const id of currentIds) {
    if (!beforeIds.has(id)) {
      added.add(id);
    }
  }
  return added;
}

/**
 * 元素包围盒:优先按 points 自算(image/freehand/line/shape/text 等本项目全部
 * 可叠加画布元素都带 points,纯计算不依赖 board);points 不可解析时退
 * RectangleClient.getRectangleByPoints,仍不可得回退 0 矩形(不与常规矩形
 * 相交,自然被白名单排除)。
 */
export function elementRect(element: PlaitElement): EditRect {
  const pts = (element as { points?: unknown }).points;
  if (Array.isArray(pts) && pts.length > 0) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts as unknown[]) {
      if (
        Array.isArray(p) &&
        typeof p[0] === 'number' &&
        typeof p[1] === 'number' &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1])
      ) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    }
    if (Number.isFinite(x0) && x1 >= x0 && y1 >= y0) {
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
  }
  try {
    const r = RectangleClient.getRectangleByPoints(
      (pts as [number, number][]) ?? []
    );
    if (Array.isArray(r) && r.length >= 4) {
      const [rx0, ry0, rx1, ry1] = r as unknown as [number, number, number, number];
      return {
        x: Math.min(rx0, rx1),
        y: Math.min(ry0, ry1),
        width: Math.abs(rx1 - rx0),
        height: Math.abs(ry1 - ry0),
      };
    }
  } catch {
    /* 不可得元素按 0 矩形处理 */
  }
  return { x: 0, y: 0, width: 0, height: 0 };
}

/** 矩形相交(含边界相切:贴边素材不丢) */
export function rectsIntersect(a: EditRect, b: EditRect): boolean {
  return (
    a.x <= b.x + b.width &&
    b.x <= a.x + a.width &&
    a.y <= b.y + b.height &&
    b.y <= a.y + a.height
  );
}

/**
 * 拍平白名单:会话新增 ∧ 与目标图矩形相交 ∧ 当前仍存在;不含目标图自身。
 * 旧元素即使相交也不并入(避免把编辑前内容误合入)。
 */
export function selectFlattenElements(
  targetImage: PlaitElement,
  currentElements: PlaitElement[],
  sessionAddedIds: Set<string>
): PlaitElement[] {
  const targetRect = elementRect(targetImage);
  return currentElements.filter(
    (el) =>
      el.id !== targetImage.id &&
      sessionAddedIds.has(el.id ?? '') &&
      rectsIntersect(elementRect(el), targetRect)
  );
}

export interface CropWindow {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * 裁剪窗口:toImage 输出=联合包围盒渲染图(padding 0),要把"原图矩形"从
 * 输出图中裁出来。各轴独立按 输出尺寸/联合尺寸 缩放,并钳制到输出边界内。
 */
export function computeCropWindow(
  targetRect: EditRect,
  unionRect: EditRect,
  outputSize: { width: number; height: number }
): CropWindow {
  const scaleX =
    unionRect.width > 0 ? outputSize.width / unionRect.width : 1;
  const scaleY =
    unionRect.height > 0 ? outputSize.height / unionRect.height : 1;
  const sx = Math.max(0, (targetRect.x - unionRect.x) * scaleX);
  const sy = Math.max(0, (targetRect.y - unionRect.y) * scaleY);
  const sw = Math.min(targetRect.width * scaleX, outputSize.width - sx);
  const sh = Math.min(targetRect.height * scaleY, outputSize.height - sy);
  return { sx, sy, sw, sh };
}

export interface FlattenSnapshot {
  /** 合并时被移除的元素原始数据(目标图+叠加),撤销时原样重插 */
  removedElements: PlaitElement[];
  /** 替换位置(原目标图矩形) */
  replaceRect: EditRect;
}

export function buildFlattenSnapshot(
  removedElements: PlaitElement[],
  replaceRect: EditRect
): FlattenSnapshot {
  return {
    removedElements: removedElements.map((el) =>
      structuredClone(el)
    ) as PlaitElement[],
    replaceRect,
  };
}

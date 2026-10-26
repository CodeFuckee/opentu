/**
 * 缩放显示工具。
 *
 * 空画布（如安全模式新建的空板）上 board.viewport.zoom 可能是 -Infinity：
 * 它是 truthy 值，`zoom || 1` 兜不住，会渲染出「-Infinity%」，
 * 参与缩放/视口运算也会把 -Infinity 继续传播（如 -Infinity + 0.1）。
 * 统一在这里做有限性守卫，非正有限值一律按未缩放（1 = 100%）处理。
 */

/** 把 viewport.zoom 归一为可用于缩放运算与显示的数值（非法值回退 1） */
export function usableZoom(zoom: number | null | undefined): number {
  return isUsableZoom(zoom) ? (zoom as number) : 1;
}

/** 把 viewport.zoom 格式化为整数百分比（非法值回退 100） */
export function formatZoomPercent(zoom: number | null | undefined): number {
  return Math.round(usableZoom(zoom) * 100);
}

/** zoom 是否为可用于缩放计算的正有限数 */
export function isUsableZoom(zoom: number | null | undefined): boolean {
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0;
}

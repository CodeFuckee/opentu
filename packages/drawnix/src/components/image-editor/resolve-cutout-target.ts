/**
 * 「智能抠图」选中目标解析:从画布当前选中元素中解析可抠图目标。
 * 契约:仅单张非 SVG 位图图片可抠;其余情况给出明确失败原因供 toast 提示。
 */
import { PlaitElement } from '@plait/core';
import { PlaitDrawElement } from '@plait/draw';

export type CutoutTargetReason = 'empty' | 'multiple' | 'not-image' | 'svg-image';

export type CutoutTarget =
  | { ok: true; element: PlaitDrawElement }
  | { ok: false; reason: CutoutTargetReason };

function isSvgImageUrl(url: string): boolean {
  return (
    url.startsWith('data:image/svg+xml') ||
    /\.svg(\?|#|$)/i.test(url)
  );
}

export function resolveCutoutTarget(
  elements: PlaitElement[]
): CutoutTarget {
  if (elements.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (elements.length > 1) {
    return { ok: false, reason: 'multiple' };
  }
  const element = elements[0];
  if (
    !PlaitDrawElement.isDrawElement(element) ||
    !PlaitDrawElement.isImage(element) ||
    !element.url
  ) {
    return { ok: false, reason: 'not-image' };
  }
  if (isSvgImageUrl(element.url)) {
    return { ok: false, reason: 'svg-image' };
  }
  return { ok: true, element };
}

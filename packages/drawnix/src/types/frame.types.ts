/**
 * Frame 容器类型定义
 */
import { PlaitElement, Point } from '@plait/core';

export interface PlaitFrame extends PlaitElement {
  type: 'frame';
  name: string;
  points: [Point, Point];
  /** 背景图 URL */
  backgroundUrl?: string;
}

export const isFrameElement = (
  element: PlaitElement
): element is PlaitFrame => {
  return element.type === 'frame';
};

const DEFAULT_FRAME_DISPLAY_NAME_REGEXP =
  /^(?:Frame|Slide|PPT\s*页面)\s*(\d+)$/i;

/**
 * 默认 Frame 名（Frame N / Slide N / PPT 页面 N）匹配。
 * 原先在 with-frame.ts、FramePanel.tsx、frame-insertion-utils.ts 各有一份
 * 同义正则，收敛到此中立模块共享。
 */
export const DEFAULT_FRAME_NAME_REGEXP = /^(?:Frame|Slide|PPT\s*页面)\s*\d+$/i;

export const getFrameDisplayName = (
  frame?: Pick<PlaitFrame, 'name'>,
  fallbackIndex?: number
): string => {
  const name = frame?.name?.trim();
  const defaultNameMatch = name?.match(DEFAULT_FRAME_DISPLAY_NAME_REGEXP);
  if (defaultNameMatch) {
    return `PPT 页面 ${defaultNameMatch[1]}`;
  }
  if (name) {
    return name;
  }
  if (typeof fallbackIndex === 'number') {
    return `PPT 页面 ${fallbackIndex}`;
  }
  return 'PPT 页面';
};

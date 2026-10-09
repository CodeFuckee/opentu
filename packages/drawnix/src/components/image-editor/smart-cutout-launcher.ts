/**
 * 「智能抠图」启动器:模块级事件总线。
 * 侧边栏工具/素材库动作通过 openSmartCutout 发起抠图请求,
 * SmartCutoutHost(画布上下文内)订阅后打开图片编辑器直落抠图模式。
 * 解耦原因:素材库(WinBox 窗口)与工具栏分属不同 React 子树,均无 board 依赖需求。
 */

export interface SmartCutoutSourceElement {
  id: string;
  url: string;
  /** 画布图片元素的两点坐标(左上/右下),与 Plait 图片元素一致 */
  points: [[number, number], [number, number]];
  width: number;
  height: number;
}

export interface SmartCutoutRequest {
  /** 待抠图图片 URL(画布元素 URL 或素材库素材 URL) */
  imageUrl: string;
  /** 来源画布图片元素;有则支持「覆盖原图」,无则仅插入/下载 */
  sourceElement?: SmartCutoutSourceElement;
}

type Listener = (request: SmartCutoutRequest) => void;

const listeners = new Set<Listener>();

export function openSmartCutout(request: SmartCutoutRequest): void {
  listeners.forEach((listener) => {
    try {
      listener(request);
    } catch (error) {
      console.error('[SmartCutout] 订阅者处理请求失败:', error);
    }
  });
}

/** 返回退订函数 */
export function subscribeSmartCutout(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

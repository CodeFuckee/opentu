/**
 * glb 3D 预览的加载决策纯函数(不依赖 model-viewer,可单测)。
 * 方案:docs/glb-3d-preview-design.md(#32)
 */

/** 超过该体积的模型在加载前需要用户二次确认(生产分布:均值 4.3MB,最大 ~45MB) */
export const GLB_LARGE_FILE_BYTES = 20 * 1024 * 1024;

/** 加载进度停滞判定窗口:loading 态下超过该时长无进度推进即降级 */
export const GLB_PROGRESS_STALL_MS = 30_000;

/** 打开前是否需要大文件确认 */
export function shouldPromptLargeFile(glbBytes?: number | null): boolean {
  return typeof glbBytes === 'number' && glbBytes > GLB_LARGE_FILE_BYTES;
}

export interface GlbProgressState {
  /** 最近一次进度百分比(0-100) */
  progress: number;
  /** 最近一次进度推进的时间戳 */
  lastAdvancedAt: number;
}

/**
 * 推进进度状态:仅当进度实际增长时刷新 lastAdvancedAt;
 * 停滞的重复上报不重置看门狗时钟。
 */
export function advanceProgress(
  state: GlbProgressState,
  progress: number,
  now: number
): GlbProgressState {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  if (clamped <= state.progress) {
    return state;
  }
  return { progress: clamped, lastAdvancedAt: now };
}

/** 加载是否已停滞超时:进度未到 100 且距最近推进超过窗口 */
export function isProgressStalled(state: GlbProgressState, now: number): boolean {
  return state.progress < 100 && now - state.lastAdvancedAt > GLB_PROGRESS_STALL_MS;
}

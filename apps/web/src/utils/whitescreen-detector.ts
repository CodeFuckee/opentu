/**
 * 白屏检测 · 画板缺失判定（纯函数，便于单测）
 *
 * 区分"真正的白屏/画板加载失败"与"画板被有意隐藏"（例如登录门禁 AuthGate
 * 在未登录时只渲染登录页，不挂载 .plait-board-container）。
 */

export interface WhitescreenBoardState {
  /** #root 是否已渲染出内容（React 已挂载） */
  hasContent: boolean;
  /** 页面上是否已存在画板容器（.plait-board-container） */
  hasPlaitBoard: boolean;
  /** 是否位于根路径（首页），仅首页才要求必须有画板 */
  pathname: string;
  /** 画板是否被有意隐藏（AuthGate 登录页 / 认证拦截占位） */
  isBoardHidden: boolean;
}

/**
 * 判断是否应当上报"画板组件未加载"。
 *
 * 仅当：已渲染内容、但没有画板容器、位于首页、且画板并非被有意隐藏时，
 * 才判定为异常（白屏 / 画板加载失败）。
 */
export function shouldReportBoardMissing(state: WhitescreenBoardState): boolean {
  if (!state.hasContent) {
    // 连内容都没有，属于"React 未渲染"分支，不是"画板未加载"
    return false;
  }
  if (state.hasPlaitBoard) {
    return false;
  }
  if (state.isBoardHidden) {
    // 登录门禁等场景下画板被有意隐藏，不构成白屏
    return false;
  }
  if (state.pathname !== '/') {
    // 非首页不强制要求画板
    return false;
  }
  return true;
}

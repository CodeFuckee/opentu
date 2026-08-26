/**
 * 浏览器扩展错误过滤（纯函数，便于单测）
 *
 * 浏览器扩展（background.js / content script / 注入的 api.service.ts 等）抛出的
 * 异步错误会以 unhandledrejection 形式出现在页面上下文，但其调用栈全部位于扩展
 * 自己的脚本里（例如 background.js、chrome-extension:// 等），与项目代码无关。
 *
 * 这些错误不应被当作"项目崩溃"记录进崩溃监控（会污染快照并放大日志）。
 * 本模块提供判定：错误是否来自第三方浏览器扩展。
 */

/** 扩展特征标记：栈中出现这些片段即视为扩展错误 */
const EXTENSION_STACK_MARKERS = [
  'background.js',
  'chrome-extension://',
  'moz-extension://',
  'edge://extensions',
  'safari-extension://',
  // 常见扩展内部模块名（压缩后常见命名）
  'nativeFetch',
  'api.service',
] as const;

/** 扩展特征标记：错误消息中出现的片段 */
const EXTENSION_MESSAGE_MARKERS = [
  'Extension context invalidated',
  'The message port closed before a response was received',
  'Could not establish connection. Receiving end does not exist',
] as const;

/**
 * 判定错误是否来自浏览器扩展。
 * @param error 错误对象（rejection reason）
 * @param errorMessage 错误消息（可为空，此时从 error 提取）
 */
export function isExtensionError(
  error: unknown,
  errorMessage = ''
): boolean {
  const reason = error as { message?: unknown; stack?: unknown } | null;
  const message =
    errorMessage ||
    (typeof reason?.message === 'string' ? reason.message : '');
  const stack = typeof reason?.stack === 'string' ? reason.stack : '';

  if (message && EXTENSION_MESSAGE_MARKERS.some((m) => message.includes(m))) {
    return true;
  }
  if (stack && EXTENSION_STACK_MARKERS.some((m) => stack.includes(m))) {
    return true;
  }
  return false;
}

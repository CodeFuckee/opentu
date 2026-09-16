/**
 * Timeout Utilities
 *
 * 通用超时 Promise 工具函数，用于处理需要超时控制的异步操作。
 */

/**
 * 为 Promise 添加超时控制
 *
 * @param promise - 要执行的 Promise
 * @param timeoutMs - 超时时间（毫秒）
 * @param defaultValue - 超时时返回的默认值
 * @returns Promise 结果或默认值
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   fetchData(),
 *   5000,
 *   null
 * );
 * ```
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  defaultValue?: T
): Promise<T | undefined> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T | undefined>((resolve) => {
    timerId = setTimeout(() => resolve(defaultValue), timeoutMs);
  });
  // settle 后清理定时器，避免悬挂的 timer 延缓 SW 终止
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  });
}

/**
 * 为 Promise 添加超时控制，超时时抛出错误
 *
 * @param promise - 要执行的 Promise
 * @param timeoutMs - 超时时间（毫秒）
 * @param errorMessage - 超时错误消息
 * @returns Promise 结果
 * @throws Error 超时时抛出
 *
 * @example
 * ```typescript
 * try {
 *   const result = await withTimeoutError(fetchData(), 5000, 'Request timed out');
 * } catch (e) {
 *   console.error(e.message); // 'Request timed out'
 * }
 * ```
 */
export function withTimeoutError<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out'
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  // settle 后清理定时器，避免悬挂的 timer 延缓 SW 终止
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  });
}

/**
 * 创建一个可取消的超时 Promise
 *
 * @param timeoutMs - 超时时间（毫秒）
 * @returns 超时 Promise 和取消函数
 *
 * @example
 * ```typescript
 * const { promise, cancel } = createCancellableTimeout(5000);
 * try {
 *   await Promise.race([fetchData(), promise]);
 * } finally {
 *   cancel(); // 清理定时器
 * }
 * ```
 */
export function createCancellableTimeout(
  timeoutMs: number
): { promise: Promise<void>; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout>;

  const promise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, timeoutMs);
  });

  const cancel = () => {
    clearTimeout(timeoutId);
  };

  return { promise, cancel };
}

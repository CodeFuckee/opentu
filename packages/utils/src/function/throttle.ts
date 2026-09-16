export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let lastFunc: ReturnType<typeof setTimeout>;
  let lastRan: number | undefined;

  // 标准 leading+trailing 节流：首次立即执行；静默超过 limit 后再次调用
  // 也立即执行（此前 inThrottle 永不复位，导致首次之后永远只剩尾缘触发）
  return function(this: any, ...args: Parameters<T>) {
    const now = Date.now();
    if (lastRan === undefined || now - lastRan >= limit) {
      func.apply(this, args);
      lastRan = now;
    } else {
      clearTimeout(lastFunc);
      lastFunc = setTimeout(() => {
        func.apply(this, args);
        lastRan = Date.now();
      }, limit - (now - lastRan));
    }
  };
}

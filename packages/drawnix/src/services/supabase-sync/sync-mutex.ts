/**
 * 同步互斥锁（openspec refactor-cloud-native-sync Phase B）
 *
 * 事件驱动推送（SyncPusher）与全量 reconcile（runSync）都会写云端与本地，
 * 交错运行会交错写同一批键——统一在此串行化。
 */

let locked = false;
let waiters: Array<() => void> = [];

export function isSyncLocked(): boolean {
  return locked;
}

/** 串行执行 fn；同一时刻只有一个持有者 */
export async function runExclusiveSync<T>(fn: () => Promise<T>): Promise<T> {
  if (locked) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  locked = true;
  try {
    return await fn();
  } finally {
    locked = false;
    const next = waiters.shift();
    if (next) {
      next();
    }
  }
}

/** 测试辅助：重置锁状态 */
export function resetSyncLock(): void {
  locked = false;
  waiters = [];
}

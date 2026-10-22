/**
 * 统一变更总线（openspec refactor-cloud-native-sync Phase A）
 *
 * 各数据面存储写入点 emit 变更事件，SyncPusher 订阅并推送云端：
 * - 事件只带键（entityType/entityId/updatedAt），内容在推送时从本地缓存现读，
 *   天然拿到最新值；
 * - entityId 传 '*' 表示类型级脏标记（写入点拿不到稳定 id 或一次写多个实体时用，
 *   推送时该类型整体按 updatedAt 窗口比对）；
 * - mute()/runMuted() 包裹「下载回写」（apply-remote / delete-local），防止
 *   「下载 → 写本地 → emit → 再上传」的回声循环。
 */

import type { SyncEntityType } from './types';

export interface SyncChangeEvent {
  entityType: SyncEntityType;
  entityId: string;
  updatedAt: number;
}

type ChangeListener = (event: SyncChangeEvent) => void;

/** 类型级脏标记：推送时该类型整体收集、按 updatedAt 窗口比对 */
export const SWEEP_ENTITY_ID = '*';

class SyncChangeBus {
  private listeners = new Set<ChangeListener>();
  private muteDepth = 0;

  /** 记录一次本地写入（静默期调用直接忽略） */
  emit(
    entityType: SyncEntityType,
    entityId: string,
    updatedAt: number = Date.now()
  ): void {
    if (this.muteDepth > 0) {
      return;
    }
    const event: SyncChangeEvent = { entityType, entityId, updatedAt };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        // 单个订阅者异常不影响其他订阅者与写入方
        console.warn('[ChangeBus] listener error:', entityType, entityId, error);
      }
    }
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  mute(): void {
    this.muteDepth++;
  }

  unmute(): void {
    this.muteDepth = Math.max(0, this.muteDepth - 1);
  }

  /** 包裹一段本地回写操作，期间的 emit 全部静默（异常也恢复计数） */
  async runMuted<T>(fn: () => Promise<T> | T): Promise<T> {
    this.mute();
    try {
      return await fn();
    } finally {
      this.unmute();
    }
  }

  /** 测试辅助 */
  listenerCount(): number {
    return this.listeners.size;
  }

  reset(): void {
    this.listeners.clear();
    this.muteDepth = 0;
  }
}

/** 全局单例 */
export const changeBus = new SyncChangeBus();

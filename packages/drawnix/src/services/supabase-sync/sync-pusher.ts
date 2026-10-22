/**
 * SyncPusher：事件驱动推送器（openspec refactor-cloud-native-sync Phase B）
 *
 * 取代「30s 全量防抖同步」成为写入上云的主路径：
 * 1. 订阅 ChangeBus（各存储写点 emit）→ 变更先持久化 Outbox（崩溃/离线不丢）
 * 2. 短防抖聚合 → 按脏键/脏类型定向收集（成本 O(脏)，不整快照）→ upsert 云端 → 出队
 * 3. 键级请求但本地已删除的键 → 云端软删除墓碑（跨设备真删除）
 * 4. 失败指数退避重试；恢复在线立即回放；与全量 reconcile 共享互斥锁
 *
 * 全部 I/O 依赖注入（默认接线真实实现），便于单测。
 */

import { changeBus } from './change-bus';
import {
  buildOutboxKey,
  clearOutbox,
  enqueueOutbox,
  listOutbox,
  markOutboxFailed,
  removeOutboxKeys,
  type OutboxEntry,
} from './outbox';
import { collectEntitiesForSync } from './local-collector';
import {
  softDeleteRemoteEntities,
  upsertRemoteEntities,
} from './repository';
import type { SupabaseSyncConfig, SyncEntity } from './types';
import { runExclusiveSync } from './sync-mutex';
import { getSupabaseSyncConfig, getSupabaseSyncUser } from './runtime';
import { installSyncWritePointWiring } from './write-point-wiring';
import { workspaceService } from '../workspace-service';

/** 默认防抖：聚合写入突发，同时保证秒级上云体感 */
export const PUSH_DEBOUNCE_MS = 3000;
/** 退避上限 */
export const RETRY_BACKOFF_MAX_MS = 5 * 60 * 1000;

/** 推送状态（UI 徽标消费） */
export interface SyncPusherStatus {
  /** outbox 待推送条数 */
  pending: number;
  /** 推送进行中 */
  syncing: boolean;
  /** 浏览器在线（离线时 pending 只增不减） */
  online: boolean;
}

export interface SyncPusherDeps {
  /** 当前同步配置（未登录为 null） */
  getConfig: () => SupabaseSyncConfig | null;
  /** 当前登录用户（未登录为 null） */
  getUser: () => Promise<{ id: string } | null>;
  /** 推送前落盘挂起的画布保存 */
  beforeFlush?: () => Promise<void>;
  /** 按脏键定向收集（默认真实实现；单测注入 fake） */
  collectForSync?: typeof collectEntitiesForSync;
  /** 批量 upsert 云端（默认真实实现；单测注入 fake） */
  upsertRemote?: (
    config: SupabaseSyncConfig,
    userId: string,
    entities: SyncEntity[]
  ) => Promise<{ data?: unknown; error?: unknown }>;
  /** 云端软删除墓碑（默认真实实现；单测注入 fake） */
  softDeleteRemote?: (
    config: SupabaseSyncConfig,
    userId: string,
    keys: string[]
  ) => Promise<{ data?: unknown; error?: unknown }>;
  debounceMs?: number;
  now?: () => number;
}

/** 单条失败退避：5s 起、指数递增、封顶 5 分钟 */
function backoffDelay(failCount: number): number {
  return Math.min(RETRY_BACKOFF_MAX_MS, 5000 * Math.pow(2, Math.max(0, failCount - 1)));
}

export class SyncPusher {
  private deps: SyncPusherDeps;
  private collect: NonNullable<SyncPusherDeps['collectForSync']>;
  private upsert: NonNullable<SyncPusherDeps['upsertRemote']>;
  private softDelete: NonNullable<SyncPusherDeps['softDeleteRemote']>;
  private unsubscribeBus: (() => void) | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushQueuedWhileRunning = false;
  private flushing = false;
  private online =
    typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  private onlineListener: (() => void) | null = null;
  private offlineListener: (() => void) | null = null;
  private statusListeners = new Set<(status: SyncPusherStatus) => void>();
  private lastStatus: SyncPusherStatus = { pending: 0, syncing: false, online: true };

  constructor(deps: SyncPusherDeps) {
    this.deps = deps;
    this.collect = deps.collectForSync ?? collectEntitiesForSync;
    this.upsert =
      deps.upsertRemote ??
      ((config, userId, entities) =>
        upsertRemoteEntities(config, userId, entities));
    this.softDelete =
      deps.softDeleteRemote ??
      ((config, userId, keys) => softDeleteRemoteEntities(config, userId, keys));
  }

  /** 接线 ChangeBus + 网络事件；重复调用幂等 */
  start(): void {
    if (this.unsubscribeBus) {
      return;
    }
    this.unsubscribeBus = changeBus.subscribe((event) => {
      void enqueueOutbox(event.entityType, event.entityId, event.updatedAt).catch(
        (error) => {
          console.warn('[SyncPusher] outbox enqueue failed:', error);
        }
      );
      this.scheduleFlush(this.deps.debounceMs ?? PUSH_DEBOUNCE_MS);
    });
    this.onlineListener = () => {
      this.online = true;
      this.notify();
      // 恢复在线立即回放积压
      this.scheduleFlush(0);
    };
    this.offlineListener = () => {
      this.online = false;
      this.notify();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineListener);
      window.addEventListener('offline', this.offlineListener);
    }
    // 启动回放：上次会话遗留的 outbox（崩溃/关闭前未推送完的变更）
    this.scheduleFlush(1000);
  }

  stop(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (typeof window !== 'undefined') {
      if (this.onlineListener) {
        window.removeEventListener('online', this.onlineListener);
      }
      if (this.offlineListener) {
        window.removeEventListener('offline', this.offlineListener);
      }
    }
    this.onlineListener = null;
    this.offlineListener = null;
  }

  /** 清空队列（登出用） */
  async reset(): Promise<void> {
    await clearOutbox();
    this.notify();
  }

  onStatus(listener: (status: SyncPusherStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.lastStatus);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** 立即推送（手动救急/测试） */
  flushNow(): void {
    this.scheduleFlush(0);
  }

  async pendingCount(): Promise<number> {
    return (await listOutbox()).length;
  }

  private scheduleFlush(delay: number): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delay);
  }

  private async notify(pending?: number, syncing?: boolean): Promise<void> {
    const count = pending ?? (await this.pendingCount());
    this.lastStatus = {
      pending: count,
      syncing: syncing ?? this.flushing,
      online: this.online,
    };
    for (const listener of [...this.statusListeners]) {
      try {
        listener(this.lastStatus);
      } catch {
        // UI 订阅者异常不影响推送
      }
    }
  }

  /**
   * 推送一轮 outbox。可重入：推送期间的新变更在下一轮处理。
   */
  async flush(): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) {
      return;
    }
    if (this.flushing) {
      this.flushQueuedWhileRunning = true;
      return;
    }
    this.flushing = true;
    try {
      // 未登录（如刚登出）直接跳过，条目保留
      const user = await this.deps.getUser();
      if (!user) {
        return;
      }
      await runExclusiveSync(async () => {
        // 锁内重取快照：等锁期间 reconcile 可能已消费部分变更
        const allEntries = await listOutbox();
        if (allEntries.length === 0) {
          await this.notify(0, false);
          return;
        }
        const now = this.deps.now?.() ?? Date.now();
        // 退避窗口内的失败条目本轮跳过（等下轮重试定时器）
        const eligible = allEntries.filter(
          (e) =>
            e.failCount === 0 ||
            now - (e.lastAttemptAt ?? 0) >= backoffDelay(e.failCount)
        );
        await this.notify(allEntries.length, true);
        if (eligible.length === 0) {
          this.scheduleRetry(allEntries);
          return;
        }
        await this.deps.beforeFlush?.();
        await this.flushEntries(config, user.id, eligible, allEntries);
      });
    } catch (error) {
      console.warn('[SyncPusher] flush error:', error);
    } finally {
      this.flushing = false;
      await this.notify(undefined, false);
      if (this.flushQueuedWhileRunning) {
        this.flushQueuedWhileRunning = false;
        this.scheduleFlush(PUSH_DEBOUNCE_MS);
      }
    }
  }

  /** 推送一批符合退避窗口的条目；按批次粒度出队/记失败 */
  private async flushEntries(
    config: SupabaseSyncConfig,
    userId: string,
    eligible: OutboxEntry[],
    allEntries: OutboxEntry[]
  ): Promise<void> {
    const sweepTypes = [
      ...new Set(
        eligible.filter((e) => e.entityId === '*').map((e) => e.entityType)
      ),
    ];
    const specificKeys = eligible
      .filter((e) => e.entityId !== '*')
      .map((e) => e.key);

    let collection:
      | Awaited<ReturnType<typeof collectEntitiesForSync>>
      | null = null;
    try {
      collection = await this.collect({ sweepTypes, specificKeys });
    } catch (error) {
      // 整体收集异常：保守处理为全部本轮条目失败
      await markOutboxFailed(
        eligible.map((e) => e.key),
        error
      );
      this.scheduleRetry(allEntries);
      return;
    }

    const failedTypes = new Set(collection.failedTypes);

    // 分批 upsert（沿用引擎批量语义），批次成功即出队
    const doneKeys: string[] = [];
    const failedKeys: string[] = [];
    let lastError: unknown = null;
    for (let i = 0; i < collection.entities.length; i += 200) {
      const batch = collection.entities.slice(i, i + 200);
      const { error } = await this.upsert(config, userId, batch);
      if (error) {
        lastError = error;
        // 本批实体对应的键记失败：sweep 条目保守整条记失败（下轮整类型重推）
        for (const entity of batch) {
          const key = buildOutboxKey(entity.entity_type, entity.entity_id);
          if (eligible.some((e) => e.key === key)) {
            failedKeys.push(key);
          }
        }
      } else {
        for (const entity of batch) {
          const key = buildOutboxKey(entity.entity_type, entity.entity_id);
          if (eligible.some((e) => e.key === key)) {
            doneKeys.push(key);
          }
        }
      }
    }

    // sweep 条目：类型收集/上传全程无失败才出队（否则下轮整类型重推）
    const failedTypeKeys = new Set<string>();
    for (const type of failedTypes) {
      for (const entry of eligible) {
        if (entry.entityType === type) {
          failedTypeKeys.add(entry.key);
        }
      }
    }
    const sweepEntries = eligible.filter((e) => e.entityId === '*');
    const sweepOk = sweepEntries.filter(
      (e) => !failedTypes.has(e.entityType) && !lastError
    );
    doneKeys.push(...sweepOk.map((e) => e.key));

    // 本地已删除的键 → 云端软删除墓碑（收集失败的类型除外，不误删）
    const tombstoneKeys = collection.missingKeys.filter((key) => {
      const type = key.slice(0, key.indexOf(':'));
      return !failedTypes.has(type);
    });
    if (tombstoneKeys.length > 0) {
      const { error } = await this.softDelete(config, userId, tombstoneKeys);
      if (error) {
        lastError = lastError ?? error;
      } else {
        doneKeys.push(...tombstoneKeys);
      }
    }

    if (failedKeys.length > 0 || failedTypeKeys.size > 0) {
      const keys = [
        ...new Set([...failedKeys, ...failedTypeKeys]),
      ].filter((key) => !doneKeys.includes(key));
      if (keys.length > 0) {
        await markOutboxFailed(keys, lastError ?? 'upload failed');
      }
    }
    if (doneKeys.length > 0) {
      await removeOutboxKeys([...new Set(doneKeys)]);
    }
    if (lastError || failedTypeKeys.size > 0) {
      this.scheduleRetry(allEntries);
    }
    await this.notify();
  }

  /** 失败退避：按最紧迫的待重试条目安排下一轮 */
  private scheduleRetry(allEntries: OutboxEntry[]): void {
    const now = this.deps.now?.() ?? Date.now();
    const nextAt = Math.min(
      ...allEntries.map(
        (e) => (e.lastAttemptAt ?? 0) + backoffDelay(e.failCount + 1)
      )
    );
    const delay = Math.max(1000, nextAt - now);
    this.scheduleFlush(Math.min(delay, RETRY_BACKOFF_MAX_MS));
  }
}

/**
 * 同步基础设施幂等启动器：写点接线 + 推送器启动。
 *
 * 必须在主应用挂载时调用（不依赖同步设置弹窗的 Provider——此前挂在那里导致
 * 不开弹窗推送器就不工作，工具栏指示器也拿不到状态）。
 */
let infraStarted = false;
export function ensureSyncInfraStarted(): void {
  if (infraStarted) {
    return;
  }
  infraStarted = true;
  installSyncWritePointWiring();
  syncPusher.start();
}

/** 默认单例（真实接线） */
export const syncPusher = new SyncPusher({
  getConfig: () => getSupabaseSyncConfig(),
  getUser: async () => {
    const config = getSupabaseSyncConfig();
    if (!config) {
      return null;
    }
    try {
      return await getSupabaseSyncUser(config);
    } catch {
      return null;
    }
  },
  beforeFlush: () =>
    workspaceService.flushPendingCurrentBoardSave().catch(() => undefined),
});

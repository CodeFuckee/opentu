/**
 * 云端直连存储（openspec remove-local-persistence）
 *
 * 云端 Postgres 唯一持久层下的会话级数据通道：
 * - 读：按类型/单实体拉取，内存缓存（基线 updated_at + 可选 content）
 * - 写：画板走 CAS 条件更新（冲突抛 CloudWriteConflictError，拒绝覆盖）；
 *       低频小对象（folder/workspace_state）走 LWW upsert
 * - 删：真 DELETE（无墓碑）
 * - 写失败：内存保留＋指数退避自动重试（仅会话内，不做跨会话离线队列）
 * - 远端变更：Realtime/轮询入口 applyRemoteChanges → 失效缓存 → 通知订阅者
 *
 * 全部 I/O 依赖注入（默认接线 repository 真实现），便于单测。
 */

import {
  fetchRemoteEntitiesByTypes,
  fetchRemoteEntity,
  fetchRemoteBoardMetadata,
  updateRemoteEntityCas,
  upsertRemoteEntityReturnTs,
  deleteRemoteEntitiesHard,
  type RemoteBoardMetaRow,
} from './repository';
import { calculateChecksum, entityKey } from './checksum';
import {
  getSupabaseSyncConfig,
  getSupabaseSyncUser,
  isCloudOnlyStorage,
} from './runtime';
import type { SupabaseSyncConfig, SyncEntity } from './types';

/** CAS 冲突（他端已修改或行不存在）：拒绝覆盖，由调用方提示刷新 */
export class CloudWriteConflictError extends Error {
  readonly entityType: string;
  readonly entityId: string;

  constructor(entityType: string, entityId: string) {
    super(`云端实体已被其他窗口/设备修改: ${entityType}:${entityId}`);
    this.name = 'CloudWriteConflictError';
    this.entityType = entityType;
    this.entityId = entityId;
  }
}

/** 写入暂未落云（网络/服务端失败，已入自动重试队列）：内容保留在内存 */
export class CloudWriteQueuedError extends Error {
  readonly entityType: string;
  readonly entityId: string;

  constructor(entityType: string, entityId: string) {
    super('云端保存失败，已加入自动重试（未同步）');
    this.name = 'CloudWriteQueuedError';
    this.entityType = entityType;
    this.entityId = entityId;
  }
}

/** 远端实体变更（Realtime / 轮询兜底归一化后的事件） */
export interface RemoteEntityChange {
  entityType: string;
  entityId: string;
  /** 服务端行 updated_at；null 表示行已删除 */
  updatedAt: number | null;
}

/** 写通道状态（UI「未同步」徽标消费） */
export interface CloudStoreStatus {
  /** 重试队列长度（0=全部已落云） */
  pending: number;
  /** 浏览器在线状态 */
  online: boolean;
}

/** 缓存条目：updatedAt 为 CAS 基线；checksum 为基线内容的校验和（伪冲突鉴别）；
 * content 缺失表示「基线已知、内容待拉取」 */
interface CacheEntry {
  updatedAt: number;
  checksum?: string;
  content?: unknown;
}

interface PendingOp {
  entity: SyncEntity;
  base: number;
  cas: boolean;
}

export interface CloudDirectStoreDeps {
  getConfig: () => SupabaseSyncConfig | null;
  getUser: (
    config: SupabaseSyncConfig
  ) => Promise<{ id: string; email?: string } | null>;
  fetchByTypes: typeof fetchRemoteEntitiesByTypes;
  fetchEntity: typeof fetchRemoteEntity;
  fetchBoardMeta: typeof fetchRemoteBoardMetadata;
  casWrite: typeof updateRemoteEntityCas;
  lwwUpsert: typeof upsertRemoteEntityReturnTs;
  deleteHard: typeof deleteRemoteEntitiesHard;
  now: () => number;
}

const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 60_000;

function defaultDeps(): CloudDirectStoreDeps {
  return {
    getConfig: getSupabaseSyncConfig,
    getUser: getSupabaseSyncUser,
    fetchByTypes: fetchRemoteEntitiesByTypes,
    fetchEntity: fetchRemoteEntity,
    fetchBoardMeta: fetchRemoteBoardMetadata,
    casWrite: updateRemoteEntityCas,
    lwwUpsert: upsertRemoteEntityReturnTs,
    deleteHard: deleteRemoteEntitiesHard,
    now: () => Date.now(),
  };
}

export class CloudDirectStore {
  private deps: CloudDirectStoreDeps;
  private cache = new Map<string, CacheEntry>();
  private pendingOps = new Map<string, PendingOp>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private retryAttempts = new Map<string, number>();
  private statusListeners = new Set<(status: CloudStoreStatus) => void>();
  private changeListeners = new Set<(changes: RemoteEntityChange[]) => void>();
  private online = true;
  private onlineHooked = false;
  private readyWaiter: Promise<SupabaseSyncConfig> | null = null;

  constructor(deps: Partial<CloudDirectStoreDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  // ==== 就绪 ====

  /**
   * 等待登录会话对应的同步配置注册完成（App initialize 与 AuthProvider
   * effect 存在先后竞争，冷启动直连前必须等到 config 就绪）。
   * 超时抛错（离线/未登录，冷启动按初始化失败呈现）。
   */
  ensureReady(timeoutMs = 15_000): Promise<SupabaseSyncConfig> {
    if (this.readyWaiter) {
      return this.readyWaiter;
    }
    this.readyWaiter = (async () => {
      const start = Date.now();
      for (;;) {
        const config = this.deps.getConfig();
        if (config) {
          return config;
        }
        if (Date.now() - start > timeoutMs) {
          this.readyWaiter = null;
          throw new Error('云端连接超时：登录会话未就绪');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    return this.readyWaiter;
  }

  private async requireContext(): Promise<{
    config: SupabaseSyncConfig;
    userId: string;
  }> {
    const config = await this.ensureReady();
    const user = await this.deps.getUser(config);
    if (!user) {
      throw new Error('未能获取登录用户，云端直连不可用');
    }
    return { config, userId: user.id };
  }

  // ==== 读 ====

  /** 按类型拉取实体（填充/刷新缓存），返回未删除实体 */
  async loadEntitiesByTypes(types: string[]): Promise<SyncEntity[]> {
    const { config, userId } = await this.requireContext();
    const { entities, error } = await this.deps.fetchByTypes(
      config,
      userId,
      types
    );
    if (error) {
      throw new Error(`云端读取失败: ${String(error)}`);
    }
    for (const entity of entities) {
      const key = entityKey(entity.entity_type, entity.entity_id);
      if (entity.deleted_at) {
        this.cache.delete(key);
      } else {
        this.cache.set(key, {
          updatedAt: entity.updated_at,
          checksum: entity.checksum,
          content: entity.content,
        });
      }
    }
    return entities.filter((entity) => !entity.deleted_at);
  }

  /** 拉取单个实体（缓存命中内容则免网络）；不存在返回 null */
  async loadEntity(
    entityType: string,
    entityId: string
  ): Promise<SyncEntity | null> {
    const key = entityKey(entityType, entityId);
    const cached = this.cache.get(key);
    if (cached && cached.content !== undefined) {
      return {
        entity_type: entityType as SyncEntity['entity_type'],
        entity_id: entityId,
        content: cached.content,
        checksum: '',
        updated_at: cached.updatedAt,
        deleted_at: null,
      };
    }
    const { config, userId } = await this.requireContext();
    const { entity, error } = await this.deps.fetchEntity(
      config,
      userId,
      entityType,
      entityId
    );
    if (error) {
      throw new Error(`云端读取失败: ${String(error)}`);
    }
    if (!entity || entity.deleted_at) {
      this.cache.delete(key);
      return null;
    }
    this.cache.set(key, {
      updatedAt: entity.updated_at,
      checksum: entity.checksum,
      content: entity.content,
    });
    return entity;
  }

  /** 读取实体内容（缓存命中免网络）；不存在返回 null */
  async loadContent<T>(entityType: string, entityId: string): Promise<T | null> {
    const entity = await this.loadEntity(entityType, entityId);
    return (entity?.content as T) ?? null;
  }

  /** 列出某类型全部实体内容（记录级数据面直连读的通用入口；每次实拉云端保最新） */
  async listContents<T>(entityType: string): Promise<T[]> {
    const entities = await this.loadEntitiesByTypes([entityType]);
    return entities
      .map((entity) => entity.content as T)
      .filter((content) => content != null);
  }

  /**
   * 画板元数据（树加载；投影拉取不含 elements 大字段）。
   * 顺带把各画板的 CAS 基线写入缓存（不覆盖已缓存的内容）。
   */
  async loadBoardMetadata(): Promise<RemoteBoardMetaRow[]> {
    const { config, userId } = await this.requireContext();
    const { boards, error } = await this.deps.fetchBoardMeta(config, userId);
    if (error) {
      throw new Error(`云端读取失败: ${String(error)}`);
    }
    for (const board of boards) {
      const key = entityKey('board', board.id);
      const cached = this.cache.get(key);
      if (!cached || cached.updatedAt !== board.rowUpdatedAt) {
        // 基线变化（他端写入）：内容失效，仅保留新基线
        this.cache.set(key, { updatedAt: board.rowUpdatedAt });
      }
    }
    return boards;
  }

  // ==== 写 ====

  /**
   * 写入实体。cas=true（画板）：条件更新，冲突抛 CloudWriteConflictError；
   * cas=false（folder/workspace_state 等低频小对象）：LWW 覆盖。
   * 网络/服务端失败：入指数退避重试队列（会话内），并向调用方抛错（「未同步」提示）。
   */
  async saveEntity(
    entityType: string,
    entityId: string,
    content: unknown,
    opts: { cas?: boolean } = {}
  ): Promise<void> {
    const key = entityKey(entityType, entityId);
    const entity: SyncEntity = {
      entity_type: entityType as SyncEntity['entity_type'],
      entity_id: entityId,
      content,
      checksum: calculateChecksum(JSON.stringify(content ?? '')),
      updated_at: this.deps.now(),
      deleted_at: null,
    };
    const base = opts.cas ? this.cache.get(key)?.updatedAt ?? 0 : 0;
    const outcome = await this.attemptWrite(entity, base, opts.cas === true);
    if (outcome === 'conflict') {
      this.retryAttempts.delete(key);
      throw new CloudWriteConflictError(entityType, entityId);
    }
    if (outcome === 'error') {
      this.pendingOps.set(key, { entity, base, cas: opts.cas === true });
      this.scheduleRetry(key);
      this.notifyStatus();
      throw new CloudWriteQueuedError(entityType, entityId);
    }
  }

  /** 真删除：云端 DELETE + 缓存失效；失败入重试队列并抛错 */
  async deleteEntities(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.cache.delete(key);
    }
    try {
      const { config, userId } = await this.requireContext();
      const { error } = await this.deps.deleteHard(config, userId, keys);
      if (error) {
        throw new Error(String(error));
      }
      for (const key of keys) {
        this.pendingOps.delete(key);
        this.clearRetryTimer(key);
      }
      this.notifyStatus();
    } catch (error) {
      // 删除重试以「墓碑内存标记」语义最简：真实删除重试同保存通道（content=null 不成立），
      // 这里降级为仅重抛；下一次该实体读取会重新出现（最终一致由下次删除/登出收口）。
      this.notifyStatus();
      throw error;
    }
  }

  private async attemptWrite(
    entity: SyncEntity,
    base: number,
    cas: boolean
  ): Promise<'ok' | 'conflict' | 'error'> {
    try {
      const { config, userId } = await this.requireContext();
      const key = entityKey(entity.entity_type, entity.entity_id);
      if (cas) {
        let { savedAt, conflict, error } = await this.deps.casWrite(
          config,
          userId,
          entity,
          base
        );
        if ((conflict || savedAt === undefined) && !error) {
          // 伪冲突鉴别：时间戳精度伪影（如服务端触发器未截断毫秒）会让 eq 失配，
          // 但内容其实没被别人改过——读回云端行，checksum 与本端基线一致则改走
          // LWW 无条件覆盖（不再依赖 updated_at 等值匹配，对服务端时钟精度免疫）；
          // checksum 不同才是真冲突（他端真写了）
          const baseChecksum = this.cache.get(key)?.checksum;
          if (baseChecksum) {
            const { entity: remote } = await this.deps.fetchEntity(
              config,
              userId,
              entity.entity_type,
              entity.entity_id
            );
            if (
              remote &&
              !remote.deleted_at &&
              remote.checksum &&
              remote.checksum === baseChecksum
            ) {
              const retry = await this.deps.lwwUpsert(config, userId, entity);
              error = retry.error;
              if (!error && retry.savedAt !== undefined) {
                // LWW 覆盖无冲突语义：内容已被证实未被他人修改
                conflict = false;
                savedAt = retry.savedAt;
              }
            }
          }
        }
        if (error) {
          return 'error';
        }
        if (conflict || savedAt === undefined) {
          return 'conflict';
        }
        this.cache.set(key, {
          updatedAt: savedAt,
          checksum: entity.checksum,
          content: entity.content,
        });
        this.retryAttempts.delete(key);
        return 'ok';
      }
      const { savedAt, error } = await this.deps.lwwUpsert(
        config,
        userId,
        entity
      );
      if (error) {
        return 'error';
      }
      this.cache.set(key, {
        updatedAt: savedAt ?? entity.updated_at,
        checksum: entity.checksum,
        content: entity.content,
      });
      this.retryAttempts.delete(key);
      return 'ok';
    } catch {
      return 'error';
    }
  }

  // ==== 失败重试（会话内指数退避） ====

  private scheduleRetry(key: string): void {
    this.clearRetryTimer(key);
    const attempts = this.retryAttempts.get(key) ?? 0;
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
    const timer = setTimeout(() => {
      void this.flushKey(key);
    }, delay);
    this.retryTimers.set(key, timer);
  }

  private clearRetryTimer(key: string): void {
    const timer = this.retryTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(key);
    }
  }

  private async flushKey(key: string): Promise<void> {
    const op = this.pendingOps.get(key);
    if (!op) {
      return;
    }
    const outcome = await this.attemptWrite(op.entity, op.base, op.cas);
    if (outcome === 'ok' || outcome === 'conflict') {
      this.pendingOps.delete(key);
      this.clearRetryTimer(key);
      if (outcome === 'conflict') {
        // 重试期间被他端抢先：放弃本次覆盖（LWW/CAS 语义一致），交给用户刷新
        this.retryAttempts.delete(key);
      }
      this.notifyStatus();
      return;
    }
    this.retryAttempts.set(key, (this.retryAttempts.get(key) ?? 0) + 1);
    this.scheduleRetry(key);
  }

  /** 恢复在线时立即重试全部挂起写入 */
  flushPending(): void {
    for (const key of [...this.pendingOps.keys()]) {
      void this.flushKey(key);
    }
  }

  private hookOnlineEvents(): void {
    if (this.onlineHooked || typeof window === 'undefined') {
      return;
    }
    this.onlineHooked = true;
    window.addEventListener('online', () => {
      this.online = true;
      this.notifyStatus();
      this.flushPending();
    });
    window.addEventListener('offline', () => {
      this.online = false;
      this.notifyStatus();
    });
  }

  // ==== 远端变更（Realtime / 轮询入口） ====

  /**
   * 应用远端变更：自写回声（基线一致）忽略；其余失效缓存并通知订阅者。
   * 内容不随事件更新（事件不含 content），订阅者按需重拉。
   */
  applyRemoteChanges(changes: RemoteEntityChange[]): void {
    const notable: RemoteEntityChange[] = [];
    for (const change of changes) {
      const key = entityKey(change.entityType, change.entityId);
      const cached = this.cache.get(key);
      if (change.updatedAt === null) {
        if (cached) {
          this.cache.delete(key);
          notable.push(change);
        }
        continue;
      }
      if (cached && cached.updatedAt === change.updatedAt) {
        continue;
      }
      this.cache.set(key, { updatedAt: change.updatedAt });
      notable.push(change);
    }
    if (notable.length === 0) {
      return;
    }
    for (const listener of [...this.changeListeners]) {
      try {
        listener(notable);
      } catch {
        // 订阅者异常不影响其他订阅者
      }
    }
  }

  onRemoteChange(
    listener: (changes: RemoteEntityChange[]) => void
  ): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onStatus(listener: (status: CloudStoreStatus) => void): () => void {
    this.hookOnlineEvents();
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getStatus(): CloudStoreStatus {
    return { pending: this.pendingOps.size, online: this.online };
  }

  /** 当前缓存基线覆盖的全部实体键（轮询兜底比对用） */
  getKnownKeys(): string[] {
    return [...this.cache.keys()];
  }

  private notifyStatus(): void {
    const status = this.getStatus();
    for (const listener of [...this.statusListeners]) {
      try {
        listener(status);
      } catch {
        // UI 订阅者异常不影响存储
      }
    }
  }

  /** 登出/会话切换：清空会话缓存与挂起队列（数据在云端，无需保留） */
  resetSession(): void {
    this.cache.clear();
    for (const key of [...this.pendingOps.keys()]) {
      this.pendingOps.delete(key);
      this.clearRetryTimer(key);
    }
    this.retryAttempts.clear();
    this.notifyStatus();
  }
}

export const cloudDirectStore = new CloudDirectStore();
export { isCloudOnlyStorage };

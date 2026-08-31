/**
 * 变更比较与元素级合并纯函数
 *
 * 迁移自 github-sync/data-serializer.ts 中与 Gist 无关的逻辑（同算法），
 * 去 Gist 化后供 supabase-sync 引擎复用。
 */

import { calculateChecksum, entityKey } from './checksum';
import type { SyncEntity } from './types';

/** 变更比较输入实体（客户端视角，含可选 lastSyncTime 逻辑用字段） */
export interface DiffInputEntity {
  entityType: string;
  entityId: string;
  checksum: string;
  updatedAt: number;
  deletedAt: number | null;
  /** 是否为「空」实体（首次同步时空本地画板特殊处理：下载远程） */
  isEmpty?: boolean;
}

export interface CompareOptions {
  /** 上次同步时间（null = 首次同步） */
  lastSyncTime: number | null;
  /** 已知的远程实体键集合（用于识别「本地删除 → 云端墓碑」） */
  knownRemoteKeys?: string[] | Set<string>;
}

/**
 * 比较本地与远程实体变更。
 *
 * 规则（与 github-sync compareBoardChanges 一致）：
 * - 远程墓碑且本地存在 → toDeleteLocally
 * - checksum 相同 → 跳过
 * - 双端都在 lastSyncTime 后修改 → conflicts
 * - 单端修改 → 上传/下载
 * - 首次同步（无 lastSyncTime）且本地空实体 → 下载远程
 * - 本地缺失、远程独有且未删除 → toDownload
 * - 本地缺失、远程独有、非首次同步且 knownRemoteKeys 含该键 → toTombstoneRemotely
 */
export function compareEntityDiff(
  localEntities: DiffInputEntity[],
  remoteEntities: DiffInputEntity[],
  options: CompareOptions
): {
  toUpload: string[];
  toDownload: string[];
  conflicts: string[];
  toDeleteLocally: string[];
  toTombstoneRemotely: string[];
} {
  const toUpload: string[] = [];
  const toDownload: string[] = [];
  const conflicts: string[] = [];
  const toDeleteLocally: string[] = [];
  const toTombstoneRemotely: string[] = [];

  const { lastSyncTime } = options;
  const knownRemoteKeys = options.knownRemoteKeys
    ? new Set(options.knownRemoteKeys)
    : undefined;

  // 按实体键建立集合
  const remoteByKey = new Map<string, DiffInputEntity>();
  for (const r of remoteEntities) {
    remoteByKey.set(entityKey(r.entityType, r.entityId), r);
  }

  const localKeys = new Set<string>();

  // 1. 遍历本地实体
  for (const local of localEntities) {
    const key = entityKey(local.entityType, local.entityId);
    localKeys.add(key);
    const remote = remoteByKey.get(key);

    if (!remote) {
      // 远程没有 → 上传
      toUpload.push(key);
      continue;
    }

    if (remote.deletedAt) {
      // 远程墓碑 → 本地删除
      toDeleteLocally.push(key);
      continue;
    }

    if (local.checksum === remote.checksum) {
      // 内容一致 → 跳过
      continue;
    }

    // 内容不同 → 按时间判定
    if (!lastSyncTime) {
      // 首次同步
      if (local.isEmpty) {
        toDownload.push(key);
      } else if (local.updatedAt > remote.updatedAt) {
        toUpload.push(key);
      } else {
        toDownload.push(key);
      }
    } else if (local.updatedAt > lastSyncTime && remote.updatedAt > lastSyncTime) {
      conflicts.push(key);
    } else if (local.updatedAt > lastSyncTime) {
      toUpload.push(key);
    } else {
      toDownload.push(key);
    }
  }

  // 2. 遍历远程独有实体
  for (const remote of remoteEntities) {
    const key = entityKey(remote.entityType, remote.entityId);
    if (localKeys.has(key)) {
      continue;
    }
    if (remote.deletedAt) {
      // 远程墓碑且本地本来就没有 → 无操作
      continue;
    }
    if (knownRemoteKeys?.has(key) && lastSyncTime) {
      // 上次同步时远程存在、如今本地缺失 → 本地删除过 → 云端墓碑
      toTombstoneRemotely.push(key);
    } else {
      toDownload.push(key);
    }
  }

  return { toUpload, toDownload, conflicts, toDeleteLocally, toTombstoneRemotely };
}

/** 画板元素合并输入：需要 elements 与 updatedAt 的 Board 形状 */
export interface MergeBoardInput {
  id: string;
  name?: string;
  elements: unknown[];
  updatedAt: number;
  [key: string]: unknown;
}

export type BoardLike = MergeBoardInput;

/**
 * 元素级合并两个画板（与 github-sync mergeBoardElements 同算法）：
 * - 本地独有元素保留
 * - 远程独有元素加入
 * - 同 ID 内容相同取一
 * - 同 ID 内容不同默认取本地并记为冲突
 */
export function mergeBoardElements(
  localBoard: BoardLike,
  remoteBoard: BoardLike
): {
  mergedBoard: BoardLike;
  hasConflicts: boolean;
  conflictingElements: Array<{
    elementId: string;
    localElement: unknown;
    remoteElement: unknown;
  }>;
  addedFromLocal: number;
  addedFromRemote: number;
  updated: number;
} {
  const localElements = localBoard.elements || [];
  const remoteElements = remoteBoard.elements || [];

  const localElementMap = new Map<string, unknown>();
  const remoteElementMap = new Map<string, unknown>();

  for (const el of localElements) {
    if (el && typeof el === 'object' && (el as { id?: string }).id) {
      localElementMap.set((el as { id: string }).id, el);
    }
  }

  for (const el of remoteElements) {
    if (el && typeof el === 'object' && (el as { id?: string }).id) {
      remoteElementMap.set((el as { id: string }).id, el);
    }
  }

  const mergedElements: unknown[] = [];
  const conflictingElements: Array<{
    elementId: string;
    localElement: unknown;
    remoteElement: unknown;
  }> = [];

  let addedFromLocal = 0;
  let addedFromRemote = 0;
  let updated = 0;

  const processedIds = new Set<string>();

  for (const localEl of localElements) {
    if (!localEl || typeof localEl !== 'object' || !(localEl as { id?: string }).id) {
      mergedElements.push(localEl);
      continue;
    }
    const id = (localEl as { id: string }).id;
    processedIds.add(id);
    const remoteEl = remoteElementMap.get(id);

    if (!remoteEl) {
      mergedElements.push(localEl);
      addedFromLocal++;
    } else {
      const localJson = JSON.stringify(localEl);
      const remoteJson = JSON.stringify(remoteEl);
      if (localJson === remoteJson) {
        mergedElements.push(localEl);
      } else {
        mergedElements.push(localEl);
        conflictingElements.push({
          elementId: id,
          localElement: localEl,
          remoteElement: remoteEl,
        });
        updated++;
      }
    }
  }

  for (const remoteEl of remoteElements) {
    if (!remoteEl || typeof remoteEl !== 'object' || !(remoteEl as { id?: string }).id) {
      continue;
    }
    const id = (remoteEl as { id: string }).id;
    if (processedIds.has(id)) {
      continue;
    }
    mergedElements.push(remoteEl);
    addedFromRemote++;
  }

  const mergedBoard: BoardLike = {
    ...localBoard,
    elements: mergedElements,
    updatedAt: Math.max(localBoard.updatedAt, remoteBoard.updatedAt),
  };

  return {
    mergedBoard,
    hasConflicts: conflictingElements.length > 0,
    conflictingElements,
    addedFromLocal,
    addedFromRemote,
    updated,
  };
}

/** 画板冲突解决：较新优先（相同时间默认本地） */
export function resolveBoardConflict(
  local: { updatedAt: number },
  remote: { updatedAt: number }
): 'local' | 'remote' {
  if (remote.updatedAt > local.updatedAt) {
    return 'remote';
  }
  return 'local';
}

/** 从 SyncEntity 构造变更比较输入 */
export function toDiffInput(entity: SyncEntity): DiffInputEntity {
  const content = entity.content as { elements?: unknown[] } | null;
  const isEmpty = Array.isArray(content?.elements) && content.elements.length === 0;
  return {
    entityType: entity.entity_type,
    entityId: entity.entity_id,
    checksum: entity.checksum,
    updatedAt: entity.updated_at,
    deletedAt: entity.deleted_at,
    isEmpty,
  };
}

export { calculateChecksum };
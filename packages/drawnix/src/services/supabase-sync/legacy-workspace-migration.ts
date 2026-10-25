/**
 * 存量本地画板自动上推（openspec remove-local-persistence D8 存量收口）
 *
 * 背景：flag 默认开启后，浏览器 IndexedDB 不再被读取——老用户在旧构建时代
 * 积累在 `aitu-workspace`（folders/boards/state）里的画板如果从未上云，会在
 * 云端视图中"消失"。本模块在云模式首次启动时把遗留本地数据与云端做一次
 * 合并（本地较新或缺者上推），成功后落标记不再重复。
 *
 * 读取直接走 localforage 实例（绕过 flag 分流——那些分支读的是云端），
 * 写入走 cloudDirectStore（LWW，经伪冲突自愈对时钟精度免疫）。
 * 读取器可注入，便于单测。
 */

import localforage from 'localforage';
import type { Folder, Board, WorkspaceState } from '../../types/workspace.types';
import { cloudDirectStore } from './cloud-direct-store';

const MIGRATION_MARKER = 'cloud_only_storage_ws_migration_v1';

export interface LegacyWorkspaceData {
  folders: Folder[];
  boards: Board[];
  state: WorkspaceState | null;
}

export interface LegacyMigrationDeps {
  readLegacyWorkspace: () => Promise<LegacyWorkspaceData>;
  saveEntity: typeof cloudDirectStore.saveEntity;
  loadBoardUpdatedAt: (boardId: string) => Promise<number | null>;
  loadFolderUpdatedAt: (folderId: string) => Promise<number | null>;
  loadStateExists: () => Promise<boolean>;
  markDone: () => void;
  isDone: () => boolean;
}

/** 默认实现：直读遗留 IndexedDB 三仓（与旧版 workspace-storage-service 同名同仓） */
function defaultReadLegacyWorkspace(): Promise<LegacyWorkspaceData> {
  const foldersStore = localforage.createInstance({
    name: 'aitu-workspace',
    storeName: 'folders',
  });
  const boardsStore = localforage.createInstance({
    name: 'aitu-workspace',
    storeName: 'boards',
  });
  const stateStore = localforage.createInstance({
    name: 'aitu-workspace',
    storeName: 'state',
  });
  return (async () => {
    const folders: Folder[] = [];
    await foldersStore.iterate<Folder, void>((value) => {
      if (value && value.id) folders.push(value);
    });
    const boards: Board[] = [];
    await boardsStore.iterate<Board, void>((value) => {
      if (value && value.id) boards.push(value);
    });
    const state =
      (await stateStore.getItem<WorkspaceState>('workspace_state')) || null;
    return { folders, boards, state };
  })();
}

function defaultDeps(): LegacyMigrationDeps {
  return {
    readLegacyWorkspace: defaultReadLegacyWorkspace,
    saveEntity: (entityType, entityId, content, opts) =>
      cloudDirectStore.saveEntity(entityType, entityId, content, opts),
    loadBoardUpdatedAt: async (boardId) => {
      const entity = await cloudDirectStore.loadEntity('board', boardId);
      return entity?.updated_at ?? null;
    },
    loadFolderUpdatedAt: async (folderId) => {
      const entity = await cloudDirectStore.loadEntity('folder', folderId);
      return entity?.updated_at ?? null;
    },
    loadStateExists: async () => {
      const entity = await cloudDirectStore.loadEntity(
        'workspace_state',
        'default'
      );
      return entity !== null;
    },
    markDone: () => {
      try {
        localStorage.setItem(MIGRATION_MARKER, new Date().toISOString());
      } catch {
        // 标记写失败：下次启动重试（上推为幂等 LWW）
      }
    },
    isDone: () => {
      try {
        return (
          typeof localStorage !== 'undefined' &&
          localStorage.getItem(MIGRATION_MARKER) !== null
        );
      } catch {
        return false;
      }
    },
  };
}

let deps: LegacyMigrationDeps | null = null;
let running: Promise<boolean> | null = null;

/** 测试注入 */
export function configureLegacyMigration(
  overrides: Partial<LegacyMigrationDeps>
): void {
  deps = { ...defaultDeps(), ...overrides };
}

/**
 * 执行存量上推（幂等：标记存在即跳过；并发调用合并为一次）。
 * 返回是否实际执行了合并（false = 已完成过/无遗留数据差异）。
 * 失败不落标记——下次启动自动重试。
 */
export function maybeRunLegacyWorkspaceMigration(): Promise<boolean> {
  if (running) {
    return running;
  }
  running = (async () => {
    const d = deps ?? defaultDeps();
    if (d.isDone()) {
      return false;
    }
    try {
      const legacy = await d.readLegacyWorkspace();
      let pushed = 0;

      for (const folder of legacy.folders) {
        if (!folder?.id) {
          continue;
        }
        const cloudUpdatedAt = await d.loadFolderUpdatedAt(folder.id);
        const localUpdatedAt = folder.updatedAt ?? 0;
        if (cloudUpdatedAt === null || localUpdatedAt > cloudUpdatedAt) {
          await d.saveEntity('folder', folder.id, folder, { cas: false });
          pushed++;
        }
      }

      for (const board of legacy.boards) {
        if (!board?.id) {
          continue;
        }
        const cloudUpdatedAt = await d.loadBoardUpdatedAt(board.id);
        const localUpdatedAt = board.updatedAt ?? 0;
        if (cloudUpdatedAt === null || localUpdatedAt > cloudUpdatedAt) {
          await d.saveEntity('board', board.id, board, { cas: false });
          pushed++;
        }
      }

      if (legacy.state && !(await d.loadStateExists())) {
        await d.saveEntity('workspace_state', 'default', legacy.state, {
          cas: false,
        });
        pushed++;
      }

      d.markDone();
      if (pushed > 0) {
        console.info(
          `[LegacyMigration] 存量画板上推完成：${pushed} 个实体已同步云端`
        );
      }
      return true;
    } catch (error) {
      console.warn(
        '[LegacyMigration] 存量上推失败（下次启动重试）:',
        error
      );
      return false;
    }
  })();
  running.finally(() => {
    running = null;
  });
  return running;
}

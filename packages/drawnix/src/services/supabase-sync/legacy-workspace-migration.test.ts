/**
 * legacy-workspace-migration 单测（openspec remove-local-persistence 五期）
 *
 * 覆盖：本地独有上推、云端较新保留、本地较新覆盖、云端缺失补齐（state）、
 * 标记幂等、失败不落标记（下次重试）、并发合并。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  configureLegacyMigration,
  maybeRunLegacyWorkspaceMigration,
  type LegacyMigrationDeps,
  type LegacyWorkspaceData,
} from './legacy-workspace-migration';
import type { Board, Folder } from '../../types/workspace.types';

function makeBoard(id: string, updatedAt: number): Board {
  return {
    id,
    name: `板${id}`,
    folderId: null,
    order: 0,
    elements: [],
    createdAt: updatedAt,
    updatedAt,
  } as unknown as Board;
}

function makeFolder(id: string, updatedAt: number): Folder {
  return {
    id,
    name: `夹${id}`,
    parentId: null,
    order: 0,
    createdAt: updatedAt,
    updatedAt,
  } as unknown as Folder;
}

interface Harness {
  deps: LegacyMigrationDeps;
  saveCalls: Array<{ type: string; id: string }>;
  cloudBoardUpdatedAt: Map<string, number>;
  cloudFolderUpdatedAt: Map<string, number>;
  cloudStateExists: boolean;
  legacy: LegacyWorkspaceData;
  failSave: boolean;
  markDoneCalls: number;
  done: boolean;
}

function makeHarness(overrides?: Partial<LegacyWorkspaceData>): Harness {
  const h: Harness = {
    saveCalls: [],
    cloudBoardUpdatedAt: new Map(),
    cloudFolderUpdatedAt: new Map(),
    cloudStateExists: true,
    legacy: {
      folders: [],
      boards: [],
      state: { currentBoardId: null, expandedFolderIds: [], sidebarWidth: 260, sidebarCollapsed: false },
      ...overrides,
    },
    failSave: false,
    markDoneCalls: 0,
    done: false,
  };
  const deps: LegacyMigrationDeps = {
    readLegacyWorkspace: async () => h.legacy,
    saveEntity: async (type, id) => {
      if (h.failSave) throw new Error('network down');
      h.saveCalls.push({ type, id: String(id) });
      return { savedAt: 9_999 };
    },
    loadBoardUpdatedAt: async (id) => h.cloudBoardUpdatedAt.get(id) ?? null,
    loadFolderUpdatedAt: async (id) => h.cloudFolderUpdatedAt.get(id) ?? null,
    loadStateExists: async () => h.cloudStateExists,
    markDone: () => {
      h.markDoneCalls++;
      h.done = true;
    },
    isDone: () => h.done,
  };
  h.deps = deps;
  configureLegacyMigration(deps);
  return h;
}

describe('存量本地画板自动上推', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('本地独有画板与文件夹全部上推，state 云端缺失时补齐', async () => {
    const h = makeHarness({
      folders: [makeFolder('f1', 100)],
      boards: [makeBoard('b1', 200), makeBoard('b2', 300)],
      state: { currentBoardId: 'b1', expandedFolderIds: [], sidebarWidth: 260, sidebarCollapsed: false },
    });
    h.cloudStateExists = false;

    const ran = await maybeRunLegacyWorkspaceMigration();

    expect(ran).toBe(true);
    expect(h.saveCalls.map((c) => `${c.type}:${c.id}`).sort()).toEqual([
      'board:b1',
      'board:b2',
      'folder:f1',
      'workspace_state:default',
    ]);
    expect(h.markDoneCalls).toBe(1);
  });

  it('云端较新则保留云端（不上推），本地较新则覆盖', async () => {
    const h = makeHarness({ boards: [makeBoard('old', 100), makeBoard('newer', 900)] });
    h.cloudBoardUpdatedAt.set('old', 500); // 云端 500 > 本地 100 → 保留云端
    h.cloudBoardUpdatedAt.set('newer', 400); // 云端 400 < 本地 900 → 覆盖

    await maybeRunLegacyWorkspaceMigration();

    expect(h.saveCalls).toEqual([{ type: 'board', id: 'newer' }]);
  });

  it('云端 state 已存在则不覆盖（避免跨设备当前板互相顶掉）', async () => {
    const h = makeHarness();
    h.cloudStateExists = true;

    await maybeRunLegacyWorkspaceMigration();

    expect(h.saveCalls).toEqual([]);
    expect(h.markDoneCalls).toBe(1);
  });

  it('标记幂等：已完成则直接跳过', async () => {
    const h = makeHarness({ boards: [makeBoard('b1', 100)] });
    h.done = true;

    const ran = await maybeRunLegacyWorkspaceMigration();

    expect(ran).toBe(false);
    expect(h.saveCalls).toEqual([]);
  });

  it('失败不落标记：下次调用自动重试', async () => {
    const h = makeHarness({ boards: [makeBoard('b1', 100)] });
    h.failSave = true;

    const first = await maybeRunLegacyWorkspaceMigration();
    expect(first).toBe(false);
    expect(h.markDoneCalls).toBe(0);

    h.failSave = false;
    const second = await maybeRunLegacyWorkspaceMigration();
    expect(second).toBe(true);
    expect(h.saveCalls).toEqual([{ type: 'board', id: 'b1' }]);
    expect(h.markDoneCalls).toBe(1);
  });

  it('并发调用合并为一次执行', async () => {
    const h = makeHarness({ boards: [makeBoard('b1', 100)] });

    const [a, b] = await Promise.all([
      maybeRunLegacyWorkspaceMigration(),
      maybeRunLegacyWorkspaceMigration(),
    ]);

    // 合并后两者拿到同一结果，且只推送一次
    expect(h.saveCalls).toEqual([{ type: 'board', id: 'b1' }]);
    expect([a, b].filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });
});

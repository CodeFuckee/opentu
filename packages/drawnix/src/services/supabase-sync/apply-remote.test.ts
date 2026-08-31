/**
 * apply-remote 测试
 *
 * 覆盖：
 * 1. 应用 board/folder/workspace_state 实体后会刷新工作区（workspaceService.reload）
 *    —— 否则设备 B 下载了新画板但 UI 画板列表看不到（回归 bug）
 * 2. 应用非画板实体（task/chat 等）不触发 reload
 * 3. 单个实体失败不中断整体
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  reload: vi.fn().mockResolvedValue(undefined),
  saveBoard: vi.fn().mockResolvedValue(undefined),
  saveFolder: vi.fn().mockResolvedValue(undefined),
  saveState: vi.fn().mockResolvedValue(undefined),
  mergePrompt: vi.fn().mockReturnValue(0),
  mergeVideoPrompt: vi.fn().mockReturnValue(0),
  mergeImagePrompt: vi.fn().mockReturnValue(0),
}));

vi.mock('../workspace-service', () => ({
  workspaceService: {
    reload: mocks.reload,
  },
}));

vi.mock('../workspace-storage-service', () => ({
  workspaceStorageService: {
    saveBoard: mocks.saveBoard,
    saveFolder: mocks.saveFolder,
    saveState: mocks.saveState,
    loadState: vi.fn().mockResolvedValue({ currentBoardId: null, expandedFolderIds: [] }),
  },
}));

vi.mock('../prompt-storage-service', () => ({
  mergePromptHistory: mocks.mergePrompt,
  mergeVideoPromptHistory: mocks.mergeVideoPrompt,
  mergeImagePromptHistory: mocks.mergeImagePrompt,
}));

import { applyRemoteEntities } from './apply-remote';
import type { SyncEntity } from './types';

function makeEntity(overrides: Partial<SyncEntity>): SyncEntity {
  return {
    entity_type: 'board',
    entity_id: 'b1',
    content: { id: 'b1', name: 'test', elements: [] },
    checksum: 'x',
    updated_at: 1000,
    deleted_at: null,
    ...overrides,
  };
}

describe('applyRemoteEntities', () => {
  beforeEach(() => {
    mocks.reload.mockClear();
    mocks.saveBoard.mockClear();
    mocks.saveFolder.mockClear();
    mocks.saveState.mockClear();
  });

  it('应用画板实体后刷新工作区（关键回归）', async () => {
    const result = await applyRemoteEntities([
      makeEntity({ entity_type: 'board', entity_id: 'b1' }),
    ]);
    expect(result.applied).toBe(1);
    expect(mocks.saveBoard).toHaveBeenCalledTimes(1);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('应用 folder 实体后也刷新工作区', async () => {
    await applyRemoteEntities([
      makeEntity({ entity_type: 'folder', entity_id: 'f1', content: { id: 'f1', name: 'f' } }),
    ]);
    expect(mocks.saveFolder).toHaveBeenCalledTimes(1);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('仅应用非画板实体不触发 reload', async () => {
    await applyRemoteEntities([
      makeEntity({ entity_type: 'prompt', entity_id: 'p1', content: { kind: 'prompt', content: 'hi', timestamp: 1 } }),
    ]);
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('reload 抛错不影响已写入的存储', async () => {
    mocks.reload.mockRejectedValueOnce(new Error('workspace not initialized'));
    const result = await applyRemoteEntities([
      makeEntity({ entity_type: 'board', entity_id: 'b1' }),
    ]);
    expect(result.applied).toBe(1);
    expect(mocks.saveBoard).toHaveBeenCalledTimes(1);
  });

  it('单个实体失败不中断后续实体', async () => {
    mocks.saveBoard.mockRejectedValueOnce(new Error('save failed'));
    const result = await applyRemoteEntities([
      makeEntity({ entity_type: 'board', entity_id: 'b1' }),
      makeEntity({ entity_type: 'board', entity_id: 'b2' }),
    ]);
    // b1 失败，b2 成功
    expect(result.applied).toBe(1);
    expect(result.failed).toContain('board:b1');
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('墓碑实体（deleted_at 非空）不写回本地（不复活已删除画板）', async () => {
    const result = await applyRemoteEntities([
      makeEntity({
        entity_type: 'board',
        entity_id: 'b-tomb',
        deleted_at: 3000,
      }),
      makeEntity({ entity_type: 'board', entity_id: 'b1' }),
    ]);
    // 墓碑跳过：applied 只有存活画板；saveBoard 只被调用一次（默认 b1）
    expect(result.applied).toBe(1);
    expect(mocks.saveBoard).toHaveBeenCalledTimes(1);
    const savedIds = mocks.saveBoard.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(savedIds).toEqual(['b1']);
    expect(savedIds).not.toContain('b-tomb');
  });

  it('全部为墓碑实体时不触发工作区刷新', async () => {
    const result = await applyRemoteEntities([
      makeEntity({ entity_type: 'board', entity_id: 'b1', deleted_at: 3000 }),
      makeEntity({ entity_type: 'folder', entity_id: 'f1', deleted_at: 3000 }),
    ]);
    expect(result.applied).toBe(0);
    expect(mocks.reload).not.toHaveBeenCalled();
  });
});
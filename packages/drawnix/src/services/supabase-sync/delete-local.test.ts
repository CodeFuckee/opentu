/**
 * delete-local 测试（墓碑下载侧删除）
 *
 * 覆盖：
 * 1. 云端墓碑 → 本地删除画板（下载远程的核心语义）
 * 2. 当前正在编辑的画板受保护（不删除）
 * 3. 批量删除 >50% 画板时跳过（防误删）
 * 4. 空输入不报错
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { deleteLocalEntities } from './delete-local';

const mocks = vi.hoisted(() => ({
  loadAllBoards: vi.fn().mockResolvedValue([
    { id: 'b1', name: 'A' },
    { id: 'b2', name: 'B' },
    { id: 'b3', name: 'C' },
  ]),
  deleteBoard: vi.fn().mockResolvedValue(undefined),
  deleteFolder: vi.fn().mockResolvedValue(undefined),
  getCurrentBoardId: vi.fn().mockReturnValue(null),
}));

vi.mock('../workspace-storage-service', () => ({
  workspaceStorageService: {
    loadAllBoards: mocks.loadAllBoards,
    deleteBoard: mocks.deleteBoard,
    deleteFolder: mocks.deleteFolder,
  },
}));

vi.mock('../workspace-service', () => ({
  workspaceService: {
    getState: () => ({ currentBoardId: mocks.getCurrentBoardId() }),
  },
}));

describe('deleteLocalEntities', () => {
  beforeEach(() => {
    mocks.loadAllBoards.mockResolvedValue([
      { id: 'b1', name: 'A' },
      { id: 'b2', name: 'B' },
      { id: 'b3', name: 'C' },
    ]);
    mocks.deleteBoard.mockClear();
    mocks.deleteFolder.mockClear();
    mocks.getCurrentBoardId.mockReturnValue(null);
  });

  it('云端墓碑画板 → 本地删除', async () => {
    const result = await deleteLocalEntities(['board:b2']);
    expect(result.deleted).toBe(1);
    expect(mocks.deleteBoard).toHaveBeenCalledWith('b2');
    expect(result.protectedItems).toEqual([]);
  });

  it('空输入不报错', async () => {
    const result = await deleteLocalEntities([]);
    expect(result.deleted).toBe(0);
    expect(mocks.deleteBoard).not.toHaveBeenCalled();
  });

  it('当前正在编辑的画板受保护（不删除）', async () => {
    mocks.getCurrentBoardId.mockReturnValue('b1');
    const result = await deleteLocalEntities(['board:b1', 'board:b2']);
    // b1 受保护，b2 被删除
    expect(result.protectedItems).toContain('board:b1');
    expect(result.deleted).toBe(1);
    expect(mocks.deleteBoard).toHaveBeenCalledWith('b2');
    expect(mocks.deleteBoard).not.toHaveBeenCalledWith('b1');
  });

  it('批量删除超过 50% 画板时全部跳过（防误删）', async () => {
    const result = await deleteLocalEntities(['board:b1', 'board:b2']);
    // 本地 3 块板，删 2 块 (>50%) → 整体跳过
    expect(result.deleted).toBe(0);
    expect(result.protectedItems).toEqual(['board:b1', 'board:b2']);
    expect(mocks.deleteBoard).not.toHaveBeenCalled();
  });

  it('文件夹墓碑 → 本地删除文件夹', async () => {
    const result = await deleteLocalEntities(['folder:f1']);
    expect(result.deleted).toBe(1);
    expect(mocks.deleteFolder).toHaveBeenCalledWith('f1');
  });
});
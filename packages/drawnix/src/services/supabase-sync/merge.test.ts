/**
 * 变更比较与元素级合并纯函数测试（测试先行）
 *
 * 覆盖：
 * 1. compareEntityDiff：单端修改 / 双端修改冲突 / 云端墓碑删除 / 本地删除墓碑 / 首次同步 / 空数据
 * 2. mergeBoardElements：元素级合并（本地独有 / 远程独有 / 相同 / 冲突）
 * 3. resolveBoardConflict：较新优先
 */
import { describe, it, expect } from 'vitest';
import {
  compareEntityDiff,
  mergeBoardElements,
  resolveBoardConflict,
  type DiffInputEntity,
} from './merge';

function makeEntity(overrides: Partial<DiffInputEntity> = {}): DiffInputEntity {
  return {
    entityType: 'board',
    entityId: 'b1',
    checksum: 'abc',
    updatedAt: 1000,
    deletedAt: null,
    ...overrides,
  };
}

describe('compareEntityDiff', () => {
  it('双端一致 → 无操作', () => {
    const local = [makeEntity({ entityId: 'b1', checksum: 'same', updatedAt: 1000 })];
    const remote = [makeEntity({ entityId: 'b1', checksum: 'same', updatedAt: 1000 })];
    const diff = compareEntityDiff(local, remote, { lastSyncTime: null });
    expect(diff.toUpload).toEqual([]);
    expect(diff.toDownload).toEqual([]);
    expect(diff.conflicts).toEqual([]);
    expect(diff.toDeleteLocally).toEqual([]);
    expect(diff.toTombstoneRemotely).toEqual([]);
  });

  it('仅本地修改 → 上传', () => {
    // 本地在 lastSyncTime 后修改；远程内容不同但 updatedAt 早于 lastSyncTime（未被修改）
    const local = [makeEntity({ entityId: 'b1', checksum: 'local-new', updatedAt: 2000 })];
    const remote = [makeEntity({ entityId: 'b1', checksum: 'remote-old', updatedAt: 400 })];
    const diff = compareEntityDiff(local, remote, { lastSyncTime: 500 });
    expect(diff.toUpload).toEqual(['board:b1']);
    expect(diff.toDownload).toEqual([]);
    expect(diff.conflicts).toEqual([]);
  });

  it('仅远程修改 → 下载', () => {
    const local = [makeEntity({ entityId: 'b1', checksum: 'remote-old', updatedAt: 400 })];
    const remote = [makeEntity({ entityId: 'b1', checksum: 'remote-new', updatedAt: 2000 })];
    const diff = compareEntityDiff(local, remote, { lastSyncTime: 500 });
    expect(diff.toDownload).toEqual(['board:b1']);
    expect(diff.toUpload).toEqual([]);
    expect(diff.conflicts).toEqual([]);
  });

  it('双端都在上次同步后修改 → 冲突', () => {
    const local = [makeEntity({ entityId: 'b1', checksum: 'l1', updatedAt: 2000 })];
    const remote = [makeEntity({ entityId: 'b1', checksum: 'r1', updatedAt: 1800 })];
    const diff = compareEntityDiff(local, remote, { lastSyncTime: 1000 });
    expect(diff.conflicts).toEqual(['board:b1']);
    expect(diff.toUpload).toEqual([]);
    expect(diff.toDownload).toEqual([]);
  });

  it('远程墓碑且本地未删除 → 本地删除', () => {
    const local = [makeEntity({ entityId: 'b1', checksum: 'x', updatedAt: 1000 })];
    const remote = [makeEntity({ entityId: 'b1', checksum: 'x', updatedAt: 1000, deletedAt: 3000 })];
    const diff = compareEntityDiff(local, remote, { lastSyncTime: 500 });
    expect(diff.toDeleteLocally).toEqual(['board:b1']);
  });

  it('本地缺失（远程独有且未删除）→ 下载；本地缺少实体映射到下载', () => {
    const local: DiffInputEntity[] = [];
    const remote = [makeEntity({ entityId: 'b1', updatedAt: 1000 })];
    const diff = compareEntityDiff(local, remote, { lastSyncTime: null });
    expect(diff.toDownload).toContain('board:b1');
  });

  it('本地删除（远程存在但本地缺失且远程无墓碑）→ 云端墓碑', () => {
    const local: DiffInputEntity[] = [];
    const remote = [makeEntity({ entityId: 'b1', updatedAt: 1000 })];
    const diff = compareEntityDiff(local, remote, {
      lastSyncTime: 1000,
      knownRemoteKeys: ['board:b1'],
    });
    expect(diff.toTombstoneRemotely).toEqual(['board:b1']);
  });

  it('首次同步（无 lastSyncTime）本地空板 → 下载远程', () => {
    const local = [makeEntity({ entityId: 'b1', checksum: 'empty', updatedAt: 500, isEmpty: true })];
    const remote = [makeEntity({ entityId: 'b1', checksum: 'rich', updatedAt: 1000 })];
    const diff = compareEntityDiff(local, remote, { lastSyncTime: null });
    expect(diff.toDownload).toContain('board:b1');
  });

  it('空输入不出错', () => {
    const diff = compareEntityDiff([], [], { lastSyncTime: null });
    expect(diff.toUpload).toEqual([]);
    expect(diff.toDownload).toEqual([]);
    expect(diff.conflicts).toEqual([]);
  });

  it('多实体混合：上传+下载+冲突+删除同时存在', () => {
    const local = [
      makeEntity({ entityId: 'up', checksum: 'l', updatedAt: 2000 }),
      makeEntity({ entityId: 'both', checksum: 'l', updatedAt: 2000 }),
      makeEntity({ entityId: 'same', checksum: 's', updatedAt: 1000 }),
      makeEntity({ entityId: 'del-remote', checksum: 'r', updatedAt: 1000 }),
    ];
    const remote = [
      makeEntity({ entityId: 'up', checksum: 'r-old', updatedAt: 400 }),
      makeEntity({ entityId: 'both', checksum: 'r', updatedAt: 1800 }),
      makeEntity({ entityId: 'same', checksum: 's', updatedAt: 1000 }),
      makeEntity({ entityId: 'dl', checksum: 'r', updatedAt: 2000 }),
      makeEntity({ entityId: 'del-remote', checksum: 'r', updatedAt: 1000, deletedAt: 2000 }),
    ];
    const diff = compareEntityDiff(local, remote, { lastSyncTime: 1000 });
    expect(diff.toUpload).toContain('board:up');
    expect(diff.toDownload).toContain('board:dl');
    expect(diff.conflicts).toContain('board:both');
    expect(diff.toDeleteLocally).toContain('board:del-remote');
    expect(diff.toTombstoneRemotely).toEqual([]);
  });
});

describe('mergeBoardElements', () => {
  function board(elements: Array<{ id: string; text?: string }>, updatedAt: number) {
    return {
      id: 'b1',
      name: 'Board',
      elements,
      createdAt: 100,
      updatedAt,
    } as never as Parameters<typeof mergeBoardElements>[0];
  }

  it('相同元素去重', () => {
    const local = board([{ id: 'e1', text: 'same' }], 1000);
    const remote = board([{ id: 'e1', text: 'same' }], 2000);
    const r = mergeBoardElements(local, remote);
    expect(r.mergedBoard.elements).toHaveLength(1);
    expect(r.addedFromLocal).toBe(0);
    expect(r.addedFromRemote).toBe(0);
    expect(r.conflictingElements).toHaveLength(0);
  });

  it('本地独有元素保留，远程独有元素加入', () => {
    const local = board([{ id: 'e1', text: 'local-only' }], 1000);
    const remote = board([{ id: 'e2', text: 'remote-only' }], 2000);
    const r = mergeBoardElements(local, remote);
    expect(r.mergedBoard.elements).toHaveLength(2);
    expect(r.addedFromLocal).toBe(1);
    expect(r.addedFromRemote).toBe(1);
  });

  it('同 ID 内容不同 → 冲突，默认取本地', () => {
    const local = board([{ id: 'e1', text: 'local-edit' }], 2000);
    const remote = board([{ id: 'e1', text: 'remote-edit' }], 1500);
    const r = mergeBoardElements(local, remote);
    expect(r.conflictingElements).toHaveLength(1);
    expect(r.mergedBoard.elements[0]).toEqual({ id: 'e1', text: 'local-edit' });
  });

  it('无元素 ID 的元素直接保留', () => {
    const local = board([{ noId: true } as never], 1000);
    const remote = board([], 2000);
    const r = mergeBoardElements(local, remote);
    expect(r.mergedBoard.elements).toHaveLength(1);
  });

  it('合并后 updatedAt 取较大值', () => {
    const local = board([], 1000);
    const remote = board([], 3000);
    const r = mergeBoardElements(local, remote);
    expect(r.mergedBoard.updatedAt).toBe(3000);
  });

  it('空画板合并不抛错', () => {
    const local = board([], 1000);
    const remote = board([], 2000);
    const r = mergeBoardElements(local, remote);
    expect(r.mergedBoard.elements).toHaveLength(0);
    expect(r.hasConflicts).toBe(false);
  });
});

describe('resolveBoardConflict', () => {
  it('本地较新 → 取本地', () => {
    const r = resolveBoardConflict({ updatedAt: 3000 }, { updatedAt: 1000 });
    expect(r).toBe('local');
  });

  it('远程较新 → 取远程', () => {
    const r = resolveBoardConflict({ updatedAt: 1000 }, { updatedAt: 3000 });
    expect(r).toBe('remote');
  });

  it('相同时间 → 取本地（默认）', () => {
    const r = resolveBoardConflict({ updatedAt: 1000 }, { updatedAt: 1000 });
    expect(r).toBe('local');
  });
});
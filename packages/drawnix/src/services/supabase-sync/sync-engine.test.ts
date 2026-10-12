/**
 * 同步引擎测试（测试先行）
 *
 * 引擎通过依赖注入的 client 接口执行同步：
 * - collectLocal（本地收集器，可 mock）
 * - fetchRemote / upsertRemote / softDeleteRemote / fetchRemoteMedia（Supabase 封装，可 mock）
 * 覆盖：首次全量上传、增量上传、增量下载、冲突合并、墓碑删除、媒体同步、错误处理、空数据。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runSync,
  type SupabaseSyncDeps,
  type SupabaseSyncUser,
} from './sync-engine';
import type { SyncEntity } from './types';

function makeEntity(entityId: string, overrides: Partial<SyncEntity> = {}): SyncEntity {
  return {
    entity_type: 'board',
    entity_id: entityId,
    content: { id: entityId },
    checksum: `sum-${entityId}`,
    updated_at: 1000,
    deleted_at: null,
    ...overrides,
  };
}

interface MockDeps {
  client: unknown;
  collectLocal: ReturnType<typeof vi.fn>;
  fetchRemote: ReturnType<typeof vi.fn>;
  upsertRemote: ReturnType<typeof vi.fn>;
  softDeleteRemote: ReturnType<typeof vi.fn>;
  syncMedia: ReturnType<typeof vi.fn>;
  deps: SupabaseSyncDeps;
}

function setupDeps(options: { remote?: SyncEntity[]; local?: SyncEntity[]; lastSyncTime?: number } = {}): MockDeps {
  const collectLocal = vi.fn().mockResolvedValue({
    entities: options.local ?? [],
    stats: { total: options.local?.length ?? 0 },
  });
  const fetchRemote = vi.fn().mockResolvedValue(options.remote ?? []);
  const upsertRemote = vi.fn().mockResolvedValue({ data: null, error: null });
  const softDeleteRemote = vi.fn().mockResolvedValue({ data: null, error: null });
  const syncMedia = vi.fn().mockResolvedValue({ uploaded: 0, downloaded: 0, failed: 0 });
  return {
    client: {},
    collectLocal,
    fetchRemote,
    upsertRemote,
    softDeleteRemote,
    syncMedia,
    deps: {
      client: {} as never,
      user: { id: 'u1', email: 'user@example.com' } as SupabaseSyncUser,
      lastSyncTime: options.lastSyncTime ?? null,
      collectLocal,
      fetchRemote,
      upsertRemote,
      softDeleteRemote,
      syncMedia,
    },
  };
}

describe('runSync', () => {
  it('本地与远程均为空 → 成功且无操作', async () => {
    const { deps } = setupDeps();
    const result = await runSync(deps);
    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(deps.upsertRemote).not.toHaveBeenCalled();
  });

  it('首次同步（远程为空）→ 全量上传本地', async () => {
    const local = [makeEntity('b1', { updated_at: 1000 }), makeEntity('b2', { updated_at: 2000 })];
    const { deps, upsertRemote } = setupDeps({ local, remote: [] });
    const result = await runSync(deps);
    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(2);
    expect(upsertRemote).toHaveBeenCalledTimes(1);
    const uploadedEntities = upsertRemote.mock.calls[0][2] as SyncEntity[];
    expect(uploadedEntities.map(e => e.entity_id).sort()).toEqual(['b1', 'b2']);
  });

  it('仅本地修改 → 只上传该实体', async () => {
    const local = [makeEntity('b1', { checksum: 'local-new', updated_at: 2000 })];
    const remote = [makeEntity('b1', { checksum: 'remote-old', updated_at: 1000 })];
    const { deps, upsertRemote } = setupDeps({ local, remote });
    const result = await runSync(deps);
    expect(result.uploaded).toBe(1);
    expect(upsertRemote).toHaveBeenCalledTimes(1);
  });

  it('仅远程修改 → 下载并应用本地（通过 deps.applyRemote 回调）', async () => {
    const applyRemote = vi.fn().mockResolvedValue({ applied: 1 });
    const local = [makeEntity('b1', { checksum: 'old', updated_at: 1000 })];
    const remote = [makeEntity('b1', { checksum: 'new', updated_at: 2000 })];
    const { deps } = setupDeps({ local, remote });
    const result = await runSync({ ...deps, applyRemote });
    expect(result.downloaded).toBe(1);
    expect(applyRemote).toHaveBeenCalledTimes(1);
  });

  it('双端修改 → 冲突走 resolveConflict，较新优先', async () => {
    const resolveConflict = vi.fn().mockReturnValue('remote');
    const applyRemote = vi.fn().mockResolvedValue({ applied: 1 });
    const local = [makeEntity('b1', { checksum: 'l', updated_at: 1500 })];
    const remote = [makeEntity('b1', { checksum: 'r', updated_at: 2000 })];
    const { deps, upsertRemote } = setupDeps({ local, remote, lastSyncTime: 1000 });
    const result = await runSync({ ...deps, resolveConflict, applyRemote });
    // 远程较新 → 下载远程；本地实体不上传
    expect(result.conflicts).toBe(1);
    expect(applyRemote).toHaveBeenCalledTimes(1);
    expect(upsertRemote).not.toHaveBeenCalled();
  });

  it('云端墓碑 → 本地删除', async () => {
    const deleteLocal = vi.fn().mockResolvedValue({ deleted: 1 });
    const local = [makeEntity('b1', { checksum: 'x', updated_at: 1000 })];
    const remote = [makeEntity('b1', { checksum: 'x', updated_at: 1000, deleted_at: 3000 })];
    const { deps } = setupDeps({ local, remote, lastSyncTime: 500 });
    const result = await runSync({ ...deps, deleteLocal });
    expect(result.deleted).toBe(1);
    expect(deleteLocal).toHaveBeenCalledTimes(1);
  });

  it('本地删除（远程无墓碑且已知）→ 云端软删除', async () => {
    const local: SyncEntity[] = [];
    const remote = [makeEntity('b1', { checksum: 'x', updated_at: 500 })];
    const { deps, softDeleteRemote } = setupDeps({ local, remote, lastSyncTime: 100 });
    const result = await runSync(deps);
    expect(result.deleted).toBe(1);
    expect(softDeleteRemote).toHaveBeenCalledTimes(1);
  });

  it('upsert 失败 → 返回 error 且 success=false', async () => {
    const local = [makeEntity('b1')];
    const { deps, upsertRemote } = setupDeps({ local, remote: [] });
    upsertRemote.mockResolvedValue({ data: null, error: new Error('network down') });
    const result = await runSync(deps);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('collectLocal 抛错 → 返回 error 不崩溃', async () => {
    const { deps, collectLocal } = setupDeps();
    collectLocal.mockRejectedValue(new Error('local failure'));
    const result = await runSync(deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('local failure');
  });

  it('未登录用户 → 返回 not_configured 错误', async () => {
    const { deps } = setupDeps();
    const result = await runSync({ ...deps, user: null as never });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('大量实体（1000 个）分批 upsert 不超过单批上限', async () => {
    const local = Array.from({ length: 1000 }, (_, i) =>
      makeEntity(`b${i}`, { updated_at: i })
    );
    const { deps, upsertRemote } = setupDeps({ local, remote: [] });
    await runSync(deps);
    const maxBatch = upsertRemote.mock.calls.reduce((max, call) => {
      const batch = call[2] as SyncEntity[];
      return Math.max(max, batch.length);
    }, 0);
    expect(maxBatch).toBeLessThanOrEqual(200);
  });

  it('媒体同步失败不影响主同步成功（fire-and-forget）', async () => {
    const local = [makeEntity('b1')];
    const { deps, syncMedia } = setupDeps({ local, remote: [] });
    syncMedia.mockRejectedValue(new Error('media failure'));
    const result = await runSync(deps);
    expect(result.success).toBe(true);
  });

  it('结果携带各阶段耗时 stageTimings（openspec improve-sync-performance）', async () => {
    const local = [makeEntity('b1')];
    const { deps } = setupDeps({ local, remote: [] });
    const result = await runSync(deps);
    expect(result.success).toBe(true);
    expect(result.stageTimings).toBeDefined();
    const t = result.stageTimings!;
    for (const key of [
      'collectMs',
      'remoteFetchMs',
      'diffMs',
      'uploadMs',
      'downloadMs',
      'totalMs',
    ] as const) {
      expect(t[key]).toBeGreaterThanOrEqual(0);
    }
    // 各阶段之和不超过总耗时（允许取整误差）
    const sum =
      t.collectMs + t.remoteFetchMs + t.diffMs + t.uploadMs + t.downloadMs;
    expect(sum).toBeLessThanOrEqual(t.totalMs + 5);
  });

  it('提供 fetchRemoteKeys 时：窗口参数透传且键集合来自键扫描（增量模式）', async () => {
    const now = Date.now();
    const local = [makeEntity('keep-1')];
    const { deps, softDeleteRemote } = setupDeps({
      local,
      remote: [],
      lastSyncTime: now - 60_000,
    });
    // 键扫描返回：keep-1（在）与 gone-1（本地已删、云端仍在）——gone-1 不在
    // 窗口内容里（updated_at 早于窗口），靠键扫描进入 knownRemoteKeys
    const fetchRemoteKeys = vi.fn().mockResolvedValue({
      keys: [
        { entityType: 'board', entityId: 'keep-1', updatedAt: now, deletedAt: null },
        { entityType: 'board', entityId: 'gone-1', updatedAt: now - 600_000, deletedAt: null },
      ],
      error: undefined,
    });
    const fetchRemote = vi.fn().mockResolvedValue([]);
    (deps as unknown as { fetchRemoteKeys: unknown }).fetchRemoteKeys = fetchRemoteKeys;
    (deps as unknown as { fetchRemote: unknown }).fetchRemote = fetchRemote;

    const result = await runSync(deps);
    expect(result.success).toBe(true);
    // 窗口参数 = lastSyncTime 透传给内容拉取
    expect(fetchRemote).toHaveBeenCalledWith(deps.client, 'u1', {
      sinceMs: now - 60_000,
    });
    // 键扫描被调用
    expect(fetchRemoteKeys).toHaveBeenCalledTimes(1);
    // 本地缺失 + knownRemoteKeys 含 gone-1（来自键扫描）→ 云端墓碑
    expect(softDeleteRemote).toHaveBeenCalledWith(
      deps.client,
      'u1',
      ['board:gone-1']
    );
  });

  it('未提供 fetchRemoteKeys 时保持旧行为（无窗口参数，键来自内容结果）', async () => {
    const local = [makeEntity('b1')];
    const remote = [makeEntity('r1')];
    const { deps, fetchRemote } = setupDeps({ local, remote });
    const result = await runSync(deps);
    expect(result.success).toBe(true);
    expect(fetchRemote).toHaveBeenCalledWith(deps.client, 'u1');
  });

  it('未登录早退也携带 stageTimings', async () => {
    const { deps } = setupDeps({ local: [], remote: [] });
    deps.user = null;
    const result = await runSync(deps);
    expect(result.success).toBe(false);
    expect(result.stageTimings).toBeDefined();
    expect(result.stageTimings!.totalMs).toBeGreaterThanOrEqual(0);
  });
});
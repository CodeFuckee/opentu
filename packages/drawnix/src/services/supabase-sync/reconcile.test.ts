/**
 * reconcile 模块单测（openspec refactor-cloud-native-sync Phase C）
 *
 * 守护点：
 * - 全量 reconcile 的防抖窗口（5s 内重复触发跳过，force 绕过）
 * - 基线持久化与读取（LAST_SYNC_KEY）
 * - 未登录/无会话直接跳过
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  reconcileFull,
  onReconcileStatus,
  setReconcileBaseline,
  getReconcileStatus,
} from './reconcile';
import { kvStorageService } from '../kv-storage-service';
import { clearOutbox } from './outbox';
import { resetSyncLock } from './sync-mutex';

const mockConfig = { client: {} };
const runSyncMock = vi.hoisted(() =>
  vi.fn(async () => ({
    success: true,
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    duration: 1,
  }))
);
const userMock = vi.hoisted(() => vi.fn(async () => ({ id: 'u1' })));
const configMock = vi.hoisted(() => vi.fn(() => mockConfig));

vi.mock('./runtime', () => ({
  getSupabaseSyncConfig: configMock,
  getSupabaseSyncUser: userMock,
  isCloudOnlyStorage: () => false,
}));
vi.mock('./sync-engine', () => ({ runSync: runSyncMock }));
vi.mock('./repository', () => ({
  fetchRemoteEntities: vi.fn(async () => ({ entities: [] })),
  fetchRemoteEntityKeys: vi.fn(async () => ({ keys: [] })),
  fetchRemoteEntitiesByTypes: vi.fn(async () => ({ entities: [] })),
  fetchRemoteEntity: vi.fn(async () => ({ entity: null })),
  fetchRemoteBoardMetadata: vi.fn(async () => ({ boards: [] })),
  updateRemoteEntityCas: vi.fn(async () => ({ savedAt: 0 })),
  upsertRemoteEntityReturnTs: vi.fn(async () => ({ savedAt: 0 })),
  deleteRemoteEntitiesHard: vi.fn(async () => ({})),
  upsertRemoteEntities: vi.fn(async () => ({})),
  softDeleteRemoteEntities: vi.fn(async () => ({})),
}));
vi.mock('./media-sync', () => ({
  syncMediaToSupabase: vi.fn(async () => ({
    uploaded: 0,
    downloaded: 0,
    failed: 0,
  })),
}));
vi.mock('./local-collector', () => ({
  collectLocalDataForSync: vi.fn(async () => ({
    entities: [],
    stats: { total: 0 },
    failedSources: [],
  })),
}));
vi.mock('./apply-remote', () => ({
  applyRemoteEntities: vi.fn(async () => ({ applied: 0, failed: [] })),
}));
vi.mock('./delete-local', () => ({
  deleteLocalEntities: vi.fn(async () => ({ deleted: 0, protectedItems: [] })),
}));
vi.mock('../workspace-service', () => ({
  workspaceService: {
    flushPendingCurrentBoardSave: vi.fn(async () => undefined),
  },
}));
vi.mock('./merge', () => ({
  mergeBoardElements: vi.fn(),
  resolveBoardConflict: vi.fn(() => 'local'),
  toDiffInput: vi.fn((e) => e),
}));

describe('reconcile（全量同步模块层）', () => {
  beforeEach(async () => {
    resetSyncLock();
    await clearOutbox();
    await kvStorageService.remove('supabase_sync_last_sync');
    runSyncMock.mockClear();
    configMock.mockReturnValue(mockConfig);
    // 重置基线加载缓存：新建一次模块状态不可行（单例），直接强制写基线
    await setReconcileBaseline(0);
    // setReconcileBaseline 会把 lastSyncAt 置 0——0 视为「已同步过」，为让
    // 防抖窗口不干扰用例，用 -Infinity 语义：直接删 kv 并重写为 null 不可行，
    // 因此各用例通过 force 或等待窗口控制
  });

  it('未登录（未注册配置）时直接跳过', async () => {
    configMock.mockReturnValue(null);
    const result = await reconcileFull({ force: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('未登录');
    expect(runSyncMock).not.toHaveBeenCalled();
  });

  it('force 绕过防抖窗口执行 runSync 并推进基线', async () => {
    const result = await reconcileFull({ force: true });
    expect(result.success).toBe(true);
    expect(runSyncMock).toHaveBeenCalledTimes(1);
    expect(getReconcileStatus().lastSyncAt).toBeGreaterThan(0);
    const saved = await kvStorageService.get<number>('supabase_sync_last_sync');
    expect(saved).toBeGreaterThan(0);
  });

  it('防抖窗口：刚成功过（5s 内）的非 force 触发跳过', async () => {
    await reconcileFull({ force: true });
    expect(runSyncMock).toHaveBeenCalledTimes(1);
    const second = await reconcileFull(); // 非 force，处于 5s 窗口内
    expect(second.success).toBe(true);
    expect(runSyncMock).toHaveBeenCalledTimes(1); // 未重复执行
  });

  it('无会话（token 失效）时返回错误', async () => {
    userMock.mockResolvedValueOnce(null);
    const result = await reconcileFull({ force: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('登录用户');
  });

  it('状态订阅：syncing 在执行期间为 true', async () => {
    const seen: boolean[] = [];
    const unsub = onReconcileStatus((s) => seen.push(s.syncing));
    await reconcileFull({ force: true });
    unsub();
    expect(seen[0]).toBe(false); // 订阅立即回调当前值
    expect(seen[seen.length - 1]).toBe(false); // 结束后回落
    expect(seen).toContain(true); // 执行中出现过 true
  });
});

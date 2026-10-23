/**
 * cloud-direct-store 单测（openspec remove-local-persistence）
 *
 * 覆盖：CAS 冲突/成功、LWW upsert、写入失败入队重试、缓存回声抑制、
 * 远端变更失效、真删除、会话重置。全部依赖注入 fake。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CloudDirectStore,
  CloudWriteConflictError,
  CloudWriteQueuedError,
  type CloudDirectStoreDeps,
} from './cloud-direct-store';
import type { SyncEntity } from './types';

const CONFIG = { client: {} } as never;

function baseDeps(): CloudDirectStoreDeps {
  return {
    getConfig: () => CONFIG,
    getUser: async () => ({ id: 'user-1' }),
    fetchByTypes: async () => ({ entities: [] }),
    fetchEntity: async () => ({ entity: null }),
    fetchBoardMeta: async () => ({ boards: [] }),
    casWrite: async () => ({ savedAt: 100 }),
    lwwUpsert: async () => ({ savedAt: 100 }),
    deleteHard: async () => ({}),
    now: () => 1_000,
  };
}

function makeStore(overrides: Partial<CloudDirectStoreDeps> = {}) {
  const deps = { ...baseDeps(), ...overrides };
  return new CloudDirectStore(deps);
}

describe('CloudDirectStore 写路径', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CAS 新建（base=0）走 insert，成功后更新缓存基线', async () => {
    const casWrite = vi.fn().mockResolvedValue({ savedAt: 1_234 });
    const store = makeStore({ casWrite });

    await store.saveEntity('board', 'b1', { name: 'x' }, { cas: true });

    expect(casWrite).toHaveBeenCalledOnce();
    const [, , entity, base] = casWrite.mock.calls[0];
    expect(base).toBe(0);
    expect(entity.entity_type).toBe('board');
    expect(entity.entity_id).toBe('b1');
    // 基线已更新：再次保存以新基线发起 CAS
    await store.saveEntity('board', 'b1', { name: 'y' }, { cas: true });
    const [, , , base2] = casWrite.mock.calls[1];
    expect(base2).toBe(1_234);
  });

  it('CAS 冲突抛 CloudWriteConflictError，不入重试队列', async () => {
    const casWrite = vi.fn().mockResolvedValue({ conflict: true });
    const store = makeStore({ casWrite });

    await expect(
      store.saveEntity('board', 'b1', {}, { cas: true })
    ).rejects.toBeInstanceOf(CloudWriteConflictError);
    expect(store.getStatus().pending).toBe(0);
  });

  it('LWW（cas=false）走 upsert，不入 CAS 基线比较', async () => {
    const lwwUpsert = vi.fn().mockResolvedValue({ savedAt: 2_000 });
    const casWrite = vi.fn();
    const store = makeStore({ lwwUpsert, casWrite });

    await store.saveEntity('workspace_state', 'default', { a: 1 });

    expect(lwwUpsert).toHaveBeenCalledOnce();
    expect(casWrite).not.toHaveBeenCalled();
  });

  it('写失败抛 CloudWriteQueuedError 并入重试队列，退避后自动重试成功', async () => {
    const casWrite = vi
      .fn<(...args: unknown[]) => Promise<{ savedAt?: number; error?: unknown }>>()
      .mockResolvedValueOnce({ error: 'network down' })
      .mockResolvedValue({ savedAt: 3_000 });
    const store = makeStore({ casWrite });

    await expect(
      store.saveEntity('board', 'b1', {}, { cas: true })
    ).rejects.toBeInstanceOf(CloudWriteQueuedError);
    expect(store.getStatus().pending).toBe(1);

    // 首次退避 3s
    await vi.advanceTimersByTimeAsync(3_000);
    expect(store.getStatus().pending).toBe(0);
    expect(casWrite).toHaveBeenCalledTimes(2);
    // 缓存基线以重试成功返回值为准
    await store.saveEntity('board', 'b1', {}, { cas: true });
    const [, , , base] = casWrite.mock.calls[2];
    expect(base).toBe(3_000);
  });

  it('重试期间被他端抢先（冲突）：出队放弃覆盖', async () => {
    const casWrite = vi
      .fn<(...args: unknown[]) => Promise<{ conflict?: boolean; savedAt?: number }>>()
      .mockResolvedValueOnce({ error: 'offline' })
      .mockResolvedValue({ conflict: true });
    const store = makeStore({ casWrite });

    await expect(
      store.saveEntity('board', 'b1', {}, { cas: true })
    ).rejects.toBeInstanceOf(CloudWriteQueuedError);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(store.getStatus().pending).toBe(0);
  });

  it('恢复在线时 flushPending 立即重试挂起写入', async () => {
    const casWrite = vi
      .fn<(...args: unknown[]) => Promise<{ savedAt?: number; error?: unknown }>>()
      .mockResolvedValueOnce({ error: 'offline' })
      .mockResolvedValue({ savedAt: 4_000 });
    const store = makeStore({ casWrite });

    await expect(
      store.saveEntity('board', 'b1', {}, { cas: true })
    ).rejects.toBeInstanceOf(CloudWriteQueuedError);

    store.flushPending();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getStatus().pending).toBe(0);
  });

  it('伪冲突自愈：时间戳失配但云端内容未变时，改走 LWW 覆盖成功', async () => {
    // 预置缓存：基线 100、checksum 同云端（内容没被别人改过）
    const casWrite = vi
      .fn<
        (
          _c: unknown,
          _u: string,
          e: SyncEntity,
          base: number
        ) => Promise<{ savedAt?: number; conflict?: boolean; error?: unknown }>
      >()
      .mockResolvedValue({ conflict: true }); // eq 失配（微秒精度伪影）
    const lwwUpsert = vi.fn().mockResolvedValue({ savedAt: 888 });
    const fetchEntity = vi
      .fn()
      .mockResolvedValue({
        entity: {
          entity_type: 'board',
          entity_id: 'b1',
          content: { name: '旧' },
          checksum: 'SAME',
          updated_at: 777,
          deleted_at: null,
        },
      });
    const store = makeStore({ casWrite, lwwUpsert, fetchEntity });
    const cache = (
      store as unknown as { cache: Map<string, { updatedAt: number; checksum?: string }> }
    ).cache;
    cache.set('board:b1', { updatedAt: 100, checksum: 'SAME' });

    await store.saveEntity('board', 'b1', { name: '新' }, { cas: true });

    expect(fetchEntity).toHaveBeenCalledOnce();
    expect(casWrite).toHaveBeenCalledOnce(); // 只试一次 CAS
    expect(lwwUpsert).toHaveBeenCalledOnce(); // 自愈走 LWW 覆盖
    expect(
      (store as unknown as { cache: Map<string, { updatedAt: number }> }).cache.get('board:b1')
    ).toMatchObject({ updatedAt: 888 });
  });

  it('真冲突：云端 checksum 与基线不同则不覆盖，抛 CloudWriteConflictError', async () => {
    const casWrite = vi
      .fn<
        () => Promise<{ conflict?: boolean; savedAt?: number }>
      >()
      .mockResolvedValue({ conflict: true });
    const lwwUpsert = vi.fn();
    const fetchEntity = vi.fn().mockResolvedValue({
      entity: {
        entity_type: 'board',
        entity_id: 'b1',
        content: { name: '别人的修改' },
        checksum: 'THEIRS',
        updated_at: 999,
        deleted_at: null,
      },
    });
    const store = makeStore({ casWrite, lwwUpsert, fetchEntity });
    const cache = (
      store as unknown as { cache: Map<string, { updatedAt: number; checksum?: string }> }
    ).cache;
    cache.set('board:b1', { updatedAt: 100, checksum: 'MINE' });

    await expect(
      store.saveEntity('board', 'b1', { name: '我的修改' }, { cas: true })
    ).rejects.toBeInstanceOf(CloudWriteConflictError);
    expect(fetchEntity).toHaveBeenCalledOnce();
    expect(casWrite).toHaveBeenCalledOnce();
    expect(lwwUpsert).not.toHaveBeenCalled();
  });

  it('真删除：deleteHard 调用并清除缓存', async () => {
    const deleteHard = vi.fn().mockResolvedValue({});
    const store = makeStore({ deleteHard });

    await store.deleteEntities(['board:b1', 'folder:f1']);

    expect(deleteHard).toHaveBeenCalledWith(CONFIG, 'user-1', [
      'board:b1',
      'folder:f1',
    ]);
  });
});

describe('CloudDirectStore 读路径与缓存', () => {
  it('loadEntitiesByTypes 填充缓存，loadEntity 命中缓存免网络', async () => {
    const fetchByTypes = vi.fn().mockResolvedValue({
      entities: [
        {
          entity_type: 'board',
          entity_id: 'b1',
          content: { name: '板1' },
          checksum: '',
          updated_at: 500,
          deleted_at: null,
        } as SyncEntity,
      ],
    });
    const fetchEntity = vi.fn();
    const store = makeStore({ fetchByTypes, fetchEntity });

    const entities = await store.loadEntitiesByTypes(['board']);
    expect(entities).toHaveLength(1);

    const loaded = await store.loadEntity('board', 'b1');
    expect(loaded?.content).toEqual({ name: '板1' });
    expect(loaded?.updated_at).toBe(500);
    expect(fetchEntity).not.toHaveBeenCalled();
  });

  it('loadEntity 缓存未命中时按需拉取并回填', async () => {
    const fetchEntity = vi
      .fn()
      .mockResolvedValue({
        entity: {
          entity_type: 'board',
          entity_id: 'b2',
          content: { name: '板2' },
          checksum: '',
          updated_at: 700,
          deleted_at: null,
        },
      });
    const store = makeStore({ fetchEntity });

    const loaded = await store.loadEntity('board', 'b2');
    expect(fetchEntity).toHaveBeenCalledOnce();
    expect(loaded?.content).toEqual({ name: '板2' });

    // 第二次命中缓存
    await store.loadEntity('board', 'b2');
    expect(fetchEntity).toHaveBeenCalledOnce();
  });

  it('loadBoardMetadata 更新基线但不覆盖已有内容', async () => {
    const fetchBoardMeta = vi.fn().mockResolvedValue({
      boards: [
        {
          id: 'b1',
          name: '板1',
          folderId: null,
          order: 0,
          viewport: undefined,
          theme: undefined,
          createdAt: 1,
          updatedAt: 1,
          rowUpdatedAt: 900,
        },
      ],
    });
    const store = makeStore({ fetchBoardMeta });
    // 预置缓存内容（updated_at=500）
    (store as unknown as { cache: Map<string, { updatedAt: number; content?: unknown }> })
      .cache.set('board:b1', { updatedAt: 500, content: { name: '旧内容' } });

    await store.loadBoardMetadata();
    const entry = (store as unknown as { cache: Map<string, { updatedAt: number }> })
      .cache.get('board:b1');
    // 他端已写入（900≠500）→ 内容失效，仅保留新基线
    expect(entry?.updatedAt).toBe(900);
    expect(entry?.content).toBeUndefined();
  });
});

describe('CloudDirectStore 远端变更', () => {
  it('自写回声（基线一致）忽略，不通知', () => {
    const store = makeStore();
    (store as unknown as { cache: Map<string, { updatedAt: number; content?: unknown }> })
      .cache.set('board:b1', { updatedAt: 100, content: {} });

    const listener = vi.fn();
    store.onRemoteChange(listener);
    store.applyRemoteChanges([
      { entityType: 'board', entityId: 'b1', updatedAt: 100 },
    ]);

    expect(listener).not.toHaveBeenCalled();
  });

  it('远端变更使内容失效并通知订阅者', () => {
    const store = makeStore();
    const cache = (
      store as unknown as { cache: Map<string, { updatedAt: number; content?: unknown }> }
    ).cache;
    cache.set('board:b1', { updatedAt: 100, content: {} });

    const listener = vi.fn();
    store.onRemoteChange(listener);
    store.applyRemoteChanges([
      { entityType: 'board', entityId: 'b1', updatedAt: 200 },
    ]);

    expect(listener).toHaveBeenCalledOnce();
    expect(cache.get('board:b1')).toEqual({ updatedAt: 200 });
  });

  it('远端删除（updatedAt=null）移除缓存并通知', () => {
    const store = makeStore();
    const cache = (
      store as unknown as { cache: Map<string, { updatedAt: number; content?: unknown }> }
    ).cache;
    cache.set('board:b1', { updatedAt: 100, content: {} });

    const listener = vi.fn();
    store.onRemoteChange(listener);
    store.applyRemoteChanges([
      { entityType: 'board', entityId: 'b1', updatedAt: null },
    ]);

    expect(cache.has('board:b1')).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('resetSession 清空缓存与挂起队列', async () => {
    const casWrite = vi.fn().mockResolvedValue({ error: 'offline' });
    const store = makeStore({ casWrite });
    await expect(
      store.saveEntity('board', 'b1', {}, { cas: true })
    ).rejects.toBeInstanceOf(CloudWriteQueuedError);

    store.resetSession();
    expect(store.getStatus().pending).toBe(0);
    expect(store.getKnownKeys()).toHaveLength(0);
  });
});

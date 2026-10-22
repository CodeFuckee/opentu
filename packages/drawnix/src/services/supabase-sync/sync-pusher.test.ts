import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { SyncPusher, type SyncPusherDeps } from './sync-pusher';
import { changeBus } from './change-bus';
import { enqueueOutbox, listOutbox, clearOutbox } from './outbox';
import type { SupabaseSyncConfig, SyncEntity } from './types';

const config = { client: {} } as SupabaseSyncConfig;

function makeEntity(
  type: string,
  id: string,
  updatedAt = Date.now()
): SyncEntity {
  return {
    entity_type: type as SyncEntity['entity_type'],
    entity_id: id,
    content: { id },
    checksum: `${type}:${id}`,
    updated_at: updatedAt,
    deleted_at: null,
  };
}

interface Fakes {
  collected: Array<{ sweepTypes: string[]; specificKeys: string[] }>;
  upserted: SyncEntity[][];
  tombstoned: string[][];
  upsertError: unknown | null;
  collectResult: {
    entities: SyncEntity[];
    missingKeys: string[];
    failedTypes: string[];
  };
}

function createPusher(
  overrides?: Partial<SyncPusherDeps>,
  fakes: Fakes = {
    collected: [],
    upserted: [],
    tombstoned: [],
    upsertError: null,
    collectResult: { entities: [], missingKeys: [], failedTypes: [] },
  }
): { pusher: SyncPusher; fakes: Fakes } {
  const deps: SyncPusherDeps = {
    getConfig: () => config,
    getUser: async () => ({ id: 'u1' }),
    collectForSync: async (options) => {
      fakes.collected.push({
        sweepTypes: [...(options.sweepTypes ?? [])],
        specificKeys: [...(options.specificKeys ?? [])],
      });
      return fakes.collectResult;
    },
    upsertRemote: async (_c, _uid, entities) => {
      if (fakes.upsertError) {
        return { error: fakes.upsertError };
      }
      fakes.upserted.push(entities);
      return {};
    },
    softDeleteRemote: async (_c, _uid, keys) => {
      fakes.tombstoned.push(keys);
      return {};
    },
    ...overrides,
  };
  return { pusher: new SyncPusher(deps), fakes };
}

async function seed(...keys: Array<[string, string, number?]>) {
  for (const [type, id, updatedAt] of keys) {
    await enqueueOutbox(type, id, updatedAt);
  }
}

describe('SyncPusher（事件驱动推送）', () => {
  beforeEach(async () => {
    changeBus.reset();
    await clearOutbox();
  });

  it('事件订阅：ChangeBus 事件入队 outbox', async () => {
    const { pusher } = createPusher();
    pusher.start();
    changeBus.emit('board', 'b1', 111);
    changeBus.emit('task', '*', 222);
    // 微任务内完成 IDB 写入
    await new Promise((r) => setTimeout(r, 20));
    pusher.stop();

    const entries = await listOutbox();
    expect(entries.map((e) => e.key).sort()).toEqual(['board:b1', 'task:*']);
    expect(entries.find((e) => e.key === 'board:b1')?.updatedAt).toBe(111);
  });

  it('flush：键级条目定向收集 → upsert → 出队', async () => {
    await seed(['board', 'b1'], ['task', 't1']);
    const { pusher, fakes } = createPusher(undefined, {
      collected: [],
      upserted: [],
      tombstoned: [],
      upsertError: null,
      collectResult: {
        entities: [makeEntity('board', 'b1'), makeEntity('task', 't1')],
        missingKeys: [],
        failedTypes: [],
      },
    });
    await pusher.flush();

    expect(fakes.upserted).toHaveLength(1);
    expect(fakes.upserted[0].map((e) => e.entity_id).sort()).toEqual([
      'b1',
      't1',
    ]);
    // 键级定向：收集请求带具体键
    expect(fakes.collected[0]?.specificKeys.sort()).toEqual([
      'board:b1',
      'task:t1',
    ]);
    expect(await listOutbox()).toHaveLength(0);
  });

  it('flush：本地已删除的键 → 云端软删除墓碑', async () => {
    await seed(['board', 'gone']);
    const { pusher, fakes } = createPusher(undefined, {
      collected: [],
      upserted: [],
      tombstoned: [],
      upsertError: null,
      collectResult: {
        entities: [],
        missingKeys: ['board:gone'],
        failedTypes: [],
      },
    });
    await pusher.flush();

    expect(fakes.tombstoned).toEqual([['board:gone']]);
    expect(await listOutbox()).toHaveLength(0);
  });

  it('flush：upsert 失败 → 条目保留并记失败（退避重试）', async () => {
    await seed(['task', 't1']);
    const { pusher, fakes } = createPusher(undefined, {
      collected: [],
      upserted: [],
      tombstoned: [],
      upsertError: new Error('network down'),
      collectResult: {
        entities: [makeEntity('task', 't1')],
        missingKeys: [],
        failedTypes: [],
      },
    });
    await pusher.flush();

    const entries = await listOutbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].failCount).toBe(1);
    expect(entries[0].lastError).toBe('network down');
  });

  it('flush：收集失败的类型不出队也不误标墓碑', async () => {
    await seed(['kb_note', 'dead']);
    const { pusher, fakes } = createPusher(undefined, {
      collected: [],
      upserted: [],
      tombstoned: [],
      upsertError: null,
      collectResult: {
        entities: [],
        missingKeys: ['kb_note:dead'],
        failedTypes: ['kb_note'],
      },
    });
    await pusher.flush();

    expect(fakes.tombstoned).toHaveLength(0);
    expect(await listOutbox()).toHaveLength(1); // 保留待重试
  });

  it('启动回放：sweep 条目推送后出队（崩溃/离线恢复）', async () => {
    await seed(['prompt', '*', 500]);
    const { pusher, fakes } = createPusher(undefined, {
      collected: [],
      upserted: [],
      tombstoned: [],
      upsertError: null,
      collectResult: {
        entities: [makeEntity('prompt', 'p1', 500)],
        missingKeys: [],
        failedTypes: [],
      },
    });
    await pusher.flush();

    expect(fakes.upserted[0].map((e) => e.entity_id)).toEqual(['p1']);
    expect(fakes.collected[0]?.sweepTypes).toEqual(['prompt']);
    expect(await listOutbox()).toHaveLength(0);
  });

  it('flush：未登录时跳过且条目保留', async () => {
    const { pusher } = createPusher({
      getUser: async () => null,
    });
    await seed(['task', 't1']);
    await pusher.flush();

    expect(await listOutbox()).toHaveLength(1);
  });

  it('状态通知：pending 数量随出队变化', async () => {
    const statuses: number[] = [];
    const { pusher } = createPusher(undefined, {
      collected: [],
      upserted: [],
      tombstoned: [],
      upsertError: null,
      collectResult: {
        entities: [makeEntity('board', 'b1')],
        missingKeys: [],
        failedTypes: [],
      },
    });
    pusher.onStatus((s) => statuses.push(s.pending));
    await seed(['board', 'b1']);
    await pusher.flush();
    await new Promise((r) => setTimeout(r, 10));

    expect(statuses).toContain(1);
    expect(statuses[statuses.length - 1]).toBe(0);
  });
});

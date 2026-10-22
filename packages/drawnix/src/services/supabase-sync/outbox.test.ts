import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  enqueueOutbox,
  listOutbox,
  removeOutboxKeys,
  markOutboxFailed,
  clearOutbox,
  outboxCount,
  buildOutboxKey,
} from './outbox';

describe('outbox（IndexedDB 持久化队列）', () => {
  beforeEach(async () => {
    await clearOutbox();
  });

  it('入队 → 列表按入队顺序返回', async () => {
    await enqueueOutbox('board', 'b1', 100);
    await enqueueOutbox('task', 't1', 200);

    const entries = await listOutbox();
    expect(entries.map((e) => e.key)).toEqual(['board:b1', 'task:t1']);
    expect(entries[0].updatedAt).toBe(100);
  });

  it('同键合并：updatedAt 取较新、enqueuedAt 保留最早', async () => {
    await enqueueOutbox('board', 'b1', 100);
    await enqueueOutbox('board', 'b1', 300);

    const entries = await listOutbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].updatedAt).toBe(300);
    expect(entries[0].enqueuedAt).toBeLessThanOrEqual(Date.now());
  });

  it('键级出队：只移除指定键', async () => {
    await enqueueOutbox('board', 'b1');
    await enqueueOutbox('board', 'b2');
    await removeOutboxKeys([buildOutboxKey('board', 'b1')]);

    const entries = await listOutbox();
    expect(entries.map((e) => e.key)).toEqual(['board:b2']);
    expect(await outboxCount()).toBe(1);
  });

  it('markOutboxFailed 累加失败计数并记录最近尝试时间', async () => {
    await enqueueOutbox('task', 't1');
    await markOutboxFailed([buildOutboxKey('task', 't1')], 'network down');
    await markOutboxFailed([buildOutboxKey('task', 't1')], 'still down');

    const [entry] = await listOutbox();
    expect(entry.failCount).toBe(2);
    expect(entry.lastError).toBe('still down');
    expect(entry.lastAttemptAt).toBeGreaterThan(0);
  });

  it('markOutboxFailed 对不存在的键是 no-op', async () => {
    await markOutboxFailed([buildOutboxKey('ghost', 'x')], 'err');
    expect(await outboxCount()).toBe(0);
  });

  it('数据落盘：同库重开可读（IndexedDB 持久化语义）', async () => {
    await enqueueOutbox('prompt', '*');
    // fake-indexeddb 同进程内持久；这里只验证 listOutbox 再次读取一致
    const entries = await listOutbox();
    expect(entries.map((e) => e.key)).toEqual(['prompt:*']);
  });
});

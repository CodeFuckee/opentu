import { describe, it, expect, beforeEach } from 'vitest';
import { changeBus, SWEEP_ENTITY_ID, type SyncChangeEvent } from './change-bus';

describe('SyncChangeBus', () => {
  beforeEach(() => {
    changeBus.reset();
  });

  it('订阅者收到 emit 的事件', () => {
    const received: SyncChangeEvent[] = [];
    changeBus.subscribe((e) => received.push(e));

    changeBus.emit('board', 'b1', 123);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      entityType: 'board',
      entityId: 'b1',
      updatedAt: 123,
    });
  });

  it('updatedAt 缺省取当前时间', () => {
    const before = Date.now();
    const received: SyncChangeEvent[] = [];
    changeBus.subscribe((e) => received.push(e));

    changeBus.emit('task', 't1');

    expect(received[0].updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('取消订阅后不再收到事件', () => {
    const received: SyncChangeEvent[] = [];
    const unsubscribe = changeBus.subscribe((e) => received.push(e));
    changeBus.emit('prompt', SWEEP_ENTITY_ID);
    unsubscribe();
    changeBus.emit('prompt', SWEEP_ENTITY_ID);

    expect(received).toHaveLength(1);
    expect(received[0].entityId).toBe('*');
  });

  it('mute 期间 emit 被静默，unmute 后恢复', () => {
    const received: SyncChangeEvent[] = [];
    changeBus.subscribe((e) => received.push(e));

    changeBus.mute();
    changeBus.emit('settings', 'default');
    changeBus.mute(); // 支持嵌套
    changeBus.emit('settings', 'default');
    changeBus.unmute();
    changeBus.emit('settings', 'default'); // 仍静默（一层 mute 未解除）
    changeBus.unmute();
    changeBus.emit('settings', 'default'); // 恢复

    expect(received).toHaveLength(1);
  });

  it('runMuted 包裹的回写不产生事件（异常也恢复）', async () => {
    const received: SyncChangeEvent[] = [];
    changeBus.subscribe((e) => received.push(e));

    await changeBus.runMuted(async () => {
      changeBus.emit('board', 'b1');
    });
    expect(received).toHaveLength(0);
    // mute 计数已恢复
    changeBus.emit('board', 'b2');
    expect(received).toHaveLength(1);

    await expect(
      changeBus.runMuted(async () => {
        changeBus.emit('board', 'b3');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    // 异常后 mute 仍恢复
    changeBus.emit('board', 'b4');
    expect(received).toHaveLength(2);
  });

  it('单个订阅者抛错不影响其他订阅者', () => {
    const received: SyncChangeEvent[] = [];
    changeBus.subscribe(() => {
      throw new Error('bad listener');
    });
    changeBus.subscribe((e) => received.push(e));

    expect(() => changeBus.emit('folder', 'f1')).not.toThrow();
    expect(received).toHaveLength(1);
  });
});

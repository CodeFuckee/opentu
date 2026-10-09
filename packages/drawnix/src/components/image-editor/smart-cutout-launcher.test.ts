/**
 * smart-cutout-launcher 单元测试:模块级事件总线。
 * 侧边栏/素材库通过 openSmartCutout 发起请求,SmartCutoutHost 订阅消费。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  openSmartCutout,
  subscribeSmartCutout,
  type SmartCutoutRequest,
} from './smart-cutout-launcher';

const baseRequest: SmartCutoutRequest = {
  imageUrl: 'http://example.com/a.png',
};

describe('smart-cutout-launcher', () => {

  it('openSmartCutout 将请求投递给订阅者', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSmartCutout(listener);
    openSmartCutout(baseRequest);
    expect(listener).toHaveBeenCalledWith(baseRequest);
    unsubscribe();
  });

  it('多个订阅者均收到请求', () => {
    const a = vi.fn();
    const b = vi.fn();
    const ua = subscribeSmartCutout(a);
    const ub = subscribeSmartCutout(b);
    openSmartCutout(baseRequest);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    ua();
    ub();
  });

  it('连续多次 open 依次投递', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSmartCutout(listener);
    const second: SmartCutoutRequest = {
      imageUrl: 'http://example.com/b.png',
      sourceElement: {
        id: 'img-2',
        url: 'http://example.com/b.png',
        points: [
          [0, 0],
          [50, 50],
        ],
        width: 50,
        height: 50,
      },
    };
    openSmartCutout(baseRequest);
    openSmartCutout(second);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(second);
    unsubscribe();
  });

  it('取消订阅后不再收到请求', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSmartCutout(listener);
    unsubscribe();
    openSmartCutout(baseRequest);
    expect(listener).not.toHaveBeenCalled();
  });

  it('无订阅者时 open 不抛错', () => {
    expect(() => openSmartCutout(baseRequest)).not.toThrow();
  });

  it('订阅者抛错不影响其他订阅者', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const ub = subscribeSmartCutout(good);
    const ua = subscribeSmartCutout(bad);
    expect(() => openSmartCutout(baseRequest)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    ua();
    ub();
  });
});

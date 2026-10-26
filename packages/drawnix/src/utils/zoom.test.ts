/**
 * zoom 工具单测：重点覆盖空画布 viewport.zoom = -Infinity 的展示守卫。
 * 背景：-Infinity 是 truthy，`zoom || 1` 兜不住，会渲染出「-Infinity%」。
 */
import { describe, expect, it } from 'vitest';
import { formatZoomPercent, isUsableZoom, usableZoom } from './zoom';

describe('formatZoomPercent', () => {
  it('正常缩放值按四舍五入取整', () => {
    expect(formatZoomPercent(1)).toBe(100);
    expect(formatZoomPercent(0.5)).toBe(50);
    expect(formatZoomPercent(2)).toBe(200);
    expect(formatZoomPercent(1.234)).toBe(123);
  });

  it('空画布的 -Infinity/Infinity/NaN 回退 100%', () => {
    expect(formatZoomPercent(-Infinity)).toBe(100);
    expect(formatZoomPercent(Infinity)).toBe(100);
    expect(formatZoomPercent(Number.NaN)).toBe(100);
  });

  it('未初始化（undefined/null/0/负数）回退 100%', () => {
    expect(formatZoomPercent(undefined)).toBe(100);
    expect(formatZoomPercent(null)).toBe(100);
    expect(formatZoomPercent(0)).toBe(100);
    expect(formatZoomPercent(-0.5)).toBe(100);
  });
});

describe('isUsableZoom', () => {
  it('仅正有限数为可用值', () => {
    expect(isUsableZoom(1)).toBe(true);
    expect(isUsableZoom(0.1)).toBe(true);
    expect(isUsableZoom(0)).toBe(false);
    expect(isUsableZoom(-Infinity)).toBe(false);
    expect(isUsableZoom(Number.NaN)).toBe(false);
    expect(isUsableZoom(undefined)).toBe(false);
  });
});

describe('usableZoom', () => {
  it('合法值原样返回（供缩放运算使用）', () => {
    expect(usableZoom(1)).toBe(1);
    expect(usableZoom(1.1)).toBe(1.1);
    expect(usableZoom(0.5)).toBe(0.5);
  });

  it('空画布 -Infinity 归一为 1，避免 -Infinity + 0.1 仍是 -Infinity 的无效缩放', () => {
    expect(usableZoom(-Infinity)).toBe(1);
    expect(usableZoom(Number.NaN)).toBe(1);
    expect(usableZoom(undefined)).toBe(1);
    expect(usableZoom(0)).toBe(1);
  });
});

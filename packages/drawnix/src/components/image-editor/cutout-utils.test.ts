/**
 * 抠图纯函数:坐标换算(显示→原图→编码系)与点集归并。
 * DOM 合成(destination-in)在 cutout-controller 的浏览器路径里,不在此测。
 */
import { describe, expect, it } from 'vitest';
import {
  clampPoint,
  pointFromClick,
  scaleToEncodeCoords,
  toMarkers,
} from './cutout-utils';

describe('pointFromClick', () => {
  it('按显示矩形比例换算到原图坐标并取整', () => {
    expect(pointFromClick(50, 25, 100, 100, 800, 600)).toEqual({ x: 400, y: 150 });
  });

  it('夹紧到图内', () => {
    expect(pointFromClick(-5, 0, 100, 100, 800, 600)).toEqual({ x: 0, y: 0 });
    expect(pointFromClick(105, 103, 100, 100, 800, 600)).toEqual({ x: 799, y: 599 });
  });
});

describe('clampPoint', () => {
  it('限制到 0..max-1', () => {
    expect(clampPoint(-1, 800)).toBe(0);
    expect(clampPoint(900, 800)).toBe(799);
    expect(clampPoint(5, 800)).toBe(5);
  });
});

describe('scaleToEncodeCoords', () => {
  it('原图坐标 → 编码尺寸坐标(等比)', () => {
    expect(
      scaleToEncodeCoords({ x: 400, y: 300 }, 800, 600, 400, 300)
    ).toEqual({ x: 200, y: 150 });
  });

  it('放大场景夹紧', () => {
    expect(scaleToEncodeCoords({ x: 1023, y: 767 }, 1024, 768, 512, 384)).toEqual({
      x: 511,
      y: 383,
    });
  });
});

describe('toMarkers', () => {
  it('编码系点集 → 显示用百分比标记(带标签)', () => {
    const markers = toMarkers(
      [
        { x: 256, y: 192, label: 1 },
        { x: 100, y: 50, label: 0 },
      ],
      512,
      384
    );
    expect(markers).toEqual([
      { x: 50, y: 50, label: 1 },
      { x: 100 * (100 / 512), y: 50 * (100 / 384), label: 0 },
    ]);
  });
});

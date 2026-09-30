/**
 * #103 画布即编辑器:纯函数层单测(TDD 先行)。
 * 覆盖:会话新增判定、拍平白名单(相交∧新增∧存在)、裁剪窗口数学、撤销快照。
 */
import { describe, it, expect } from 'vitest';
import {
  computeSessionAddedIds,
  selectFlattenElements,
  computeCropWindow,
  buildFlattenSnapshot,
} from './canvas-edit-utils';
import type { PlaitElement } from '@plait/core';

/** 简易图片元素(points 定位矩形) */
function img(id: string, x: number, y: number, w: number, h: number): PlaitElement {
  return {
    id,
    type: 'image',
    url: `http://x/${id}.png`,
    points: [
      [x, y],
      [x + w, y + h],
    ],
    children: [],
  } as unknown as PlaitElement;
}

/** 简易画笔元素(points 折线) */
function brush(id: string, pts: number[][]): PlaitElement {
  return {
    id,
    type: 'freehand',
    points: pts.map((p) => [p[0], p[1]]),
    children: [],
  } as unknown as PlaitElement;
}

describe('computeSessionAddedIds', () => {
  it('会话新增 = 当前集合 - 进入时集合', () => {
    const before = new Set(['a', 'b']);
    const current = new Set(['a', 'b', 'c', 'd']);
    expect(computeSessionAddedIds(before, current)).toEqual(
      new Set(['c', 'd'])
    );
  });

  it('编辑中被删除的元素不出现在新增集合', () => {
    const before = new Set(['a']);
    const current = new Set(['a']);
    expect(computeSessionAddedIds(before, current).size).toBe(0);
  });

  it('undo 把新增元素撤掉后自然不在集合(幂等)', () => {
    const before = new Set(['a']);
    expect(computeSessionAddedIds(before, new Set(['a', 'x'])).size).toBe(1);
    expect(computeSessionAddedIds(before, new Set(['a'])).size).toBe(0);
  });
});

describe('selectFlattenElements', () => {
  const target = img('target', 100, 100, 200, 100);

  it('白名单:会话新增 ∧ 与目标图相交 ∧ 当前仍存在', () => {
    const onImg = brush('b1', [[120, 120], [180, 180]]); // 相交(在图内)
    const outside = brush('b2', [[500, 500], [560, 560]]); // 不相交
    const oldOverlap = brush('b3', [[110, 110], [130, 130]]); // 相交但非会话新增
    const added = new Set(['b1', 'b2', 'gone']); // b3 为旧元素,不在会话新增集
    const current = [target, onImg, outside, oldOverlap];
    const picked = selectFlattenElements(target, current, added);
    expect(picked.map((e) => e.id)).toEqual(['b1']);
  });

  it('无任何合规叠加时返回空数组(仅拍目标图自身=原样重渲)', () => {
    expect(selectFlattenElements(target, [target], new Set())).toEqual([]);
  });

  it('目标图自身不重复入选', () => {
    const onImg = brush('b1', [[120, 120], [180, 180]]);
    const picked = selectFlattenElements(target, [target, onImg], new Set(['b1', 'target']));
    expect(picked.map((e) => e.id)).toEqual(['b1']);
  });

  it('边界相切算相交(贴边素材不丢)', () => {
    const edge = brush('e', [[300, 100], [320, 120]]); // 起点=右边界
    const picked = selectFlattenElements(target, [target, edge], new Set(['e']));
    expect(picked.map((e) => e.id)).toEqual(['e']);
  });
});

describe('computeCropWindow', () => {
  it('叠加全在图内:包围盒=目标图,裁剪窗口=整图', () => {
    const rect = { x: 100, y: 100, width: 200, height: 100 };
    const w = computeCropWindow(rect, { ...rect }, { width: 800, height: 400 });
    expect(w).toEqual({ sx: 0, sy: 0, sw: 800, sh: 400 });
  });

  it('叠加超出右边界:按比例裁出原图区域', () => {
    const target = { x: 100, y: 100, width: 200, height: 100 };
    const union = { x: 100, y: 100, width: 400, height: 100 }; // 右侧超出 200
    // 输出图 1600x400(scale=4):原图区域起点 sx=0,宽 200*4=800
    const w = computeCropWindow(target, union, { width: 1600, height: 400 });
    expect(w).toEqual({ sx: 0, sy: 0, sw: 800, sh: 400 });
  });

  it('叠加超出左与下边界:窗口起点随之偏移', () => {
    const target = { x: 100, y: 100, width: 200, height: 100 };
    const union = { x: 0, y: 100, width: 300, height: 300 }; // 左 100、下 200
    // scale=输出宽/联合宽=1200/300=4;原图起点 (100,0)→sx=400,sy=0;尺寸 800x400
    const w = computeCropWindow(target, union, { width: 1200, height: 1200 });
    expect(w).toEqual({ sx: 400, sy: 0, sw: 800, sh: 400 });
  });

  it('输出与联合包围盒比例不一致时按宽高分别缩放', () => {
    const target = { x: 10, y: 10, width: 100, height: 50 };
    const union = { x: 0, y: 0, width: 200, height: 100 };
    const w = computeCropWindow(target, union, { width: 400, height: 150 });
    expect(w).toEqual({ sx: 20, sy: 15, sw: 200, sh: 75 });
  });
});

describe('buildFlattenSnapshot', () => {
  it('快照记录被移除元素原始数据与替换位置', () => {
    const target = img('t', 50, 60, 200, 100);
    const overlay = brush('o', [[60, 70], [80, 90]]);
    const snap = buildFlattenSnapshot([target, overlay], {
      x: 50,
      y: 60,
      width: 200,
      height: 100,
    });
    expect(snap.removedElements.map((e) => e.id)).toEqual(['t', 'o']);
    expect(snap.replaceRect).toEqual({ x: 50, y: 60, width: 200, height: 100 });
  });
});

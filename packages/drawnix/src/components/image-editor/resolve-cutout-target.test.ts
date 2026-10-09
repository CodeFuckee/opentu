/**
 * resolve-cutout-target 单元测试:侧边栏「智能抠图」的选中目标解析。
 * 契约:单张非 SVG 位图图片才可抠;空选/多选/非图片/SVG 各有明确失败原因。
 */
import { describe, expect, it } from 'vitest';
import { resolveCutoutTarget } from './resolve-cutout-target';
import { PlaitElement } from '@plait/core';
import { PlaitDrawElement } from '@plait/draw';

function imageElement(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'img-1',
    type: 'image',
    url: 'http://example.com/a.png',
    points: [
      [0, 0],
      [100, 80],
    ],
    ...overrides,
  } as unknown as PlaitDrawElement;
}

function shapeElement() {
  return {
    id: 'shape-1',
    type: 'rectangle',
    points: [
      [0, 0],
      [10, 10],
    ],
  } as unknown as PlaitElement;
}

describe('resolveCutoutTarget', () => {
  it('空选择返回 empty', () => {
    const result = resolveCutoutTarget([]);
    expect(result).toEqual({ ok: false, reason: 'empty' });
  });

  it('单张位图图片返回 ok 与该元素', () => {
    const el = imageElement();
    const result = resolveCutoutTarget([el]);
    expect(result).toEqual({ ok: true, element: el });
  });

  it('多选返回 multiple', () => {
    const result = resolveCutoutTarget([imageElement(), imageElement({ id: 'img-2' })]);
    expect(result).toEqual({ ok: false, reason: 'multiple' });
  });

  it('非图片元素返回 not-image', () => {
    const result = resolveCutoutTarget([shapeElement()]);
    expect(result).toEqual({ ok: false, reason: 'not-image' });
  });

  it('SVG data URL 图片返回 svg-image', () => {
    const el = imageElement({ url: 'data:image/svg+xml;base64,PHN2Zy8+' });
    const result = resolveCutoutTarget([el]);
    expect(result).toEqual({ ok: false, reason: 'svg-image' });
  });

  it('.svg 扩展名图片返回 svg-image', () => {
    const el = imageElement({ url: 'http://example.com/icon.svg?v=1' });
    const result = resolveCutoutTarget([el]);
    expect(result).toEqual({ ok: false, reason: 'svg-image' });
  });

  it('图片元素缺 url 返回 not-image', () => {
    const el = imageElement({ url: undefined });
    const result = resolveCutoutTarget([el]);
    expect(result).toEqual({ ok: false, reason: 'not-image' });
  });

  it('多选中含非图片元素同样返回 multiple(数量优先)', () => {
    const result = resolveCutoutTarget([imageElement(), shapeElement()]);
    expect(result).toEqual({ ok: false, reason: 'multiple' });
  });
});

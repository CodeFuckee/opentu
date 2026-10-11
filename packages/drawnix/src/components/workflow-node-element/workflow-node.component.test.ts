/**
 * WorkflowNodeComponent 单测:组件销毁必须清理 activeHost 图层的选中矩形
 *
 * 回归守护:选中矩形由 WorkflowNodeSelectionGenerator 画在 activeHost
 * (g.active-host-g)图层,不在元素自己的 g 里——元素被删除时框架只移除
 * 元素 g,正常「取消选中」靠 processDrawing({selected:false}) 自动清理,
 * 而「删除选中元素」路径只走组件 destroy()。destroy() 若不显式调
 * activeGenerator.destroy(),选中矩形(#b45309)就永久残留画布
 * (参照实现 audio-node.component 的 destroy 有此清理,workflow-node 曾漏)。
 */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaitBoard, PlaitElement } from '@plait/core';
import { ElementFlavour } from '@plait/core';
import { WorkflowNodeComponent } from './workflow-node.component';
import type { PlaitWorkflowNode } from '../../types/workflow-node.types';

vi.mock('./workflow-node.generator', () => ({
  WorkflowNodeGenerator: class {
    processDrawing = vi.fn();
    updateDrawing = vi.fn();
    destroy = vi.fn();
  },
}));

function makeNode(): PlaitWorkflowNode {
  return {
    id: 'wf-del-1',
    type: 'workflow-node',
    nodeType: 'image-generation',
    params: {},
    points: [
      [0, 0],
      [220, 120],
    ],
  } as unknown as PlaitWorkflowNode;
}

function createComponent() {
  const element = makeNode();
  const board = { children: [element] } as unknown as PlaitBoard;
  // 父类 destroy 依赖真实 board 上下文(weakmap 注册表),与被测行为无关,打桩跳过
  vi.spyOn(ElementFlavour.prototype, 'destroy').mockImplementation(() => {});

  const component = new WorkflowNodeComponent(element, board);
  // 直接写 _context 绕开 context setter(setter 两个分支都会触碰 board weakmap
  // 注册表,与被测行为无关);board getter 读的正是 _context.board
  (component as unknown as { _context: unknown })._context = {
    element,
    board,
    hasThemeChanged: false,
  };
  component.initializeGenerator();
  return component;
}

describe('WorkflowNodeComponent destroy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('destroy 必须清理 activeGenerator(选中矩形图层),删除后不残留黄色边框', () => {
    const component = createComponent();
    const activeDestroy = vi.fn();
    (
      component as unknown as { activeGenerator: { destroy: () => void } }
    ).activeGenerator = { destroy: activeDestroy };

    component.destroy();

    expect(activeDestroy).toHaveBeenCalledTimes(1);
  });

  it('destroy 同时清理节点内容渲染器', () => {
    const component = createComponent();
    const nodeDestroy = (
      component as unknown as { nodeGenerator: { destroy: ReturnType<typeof vi.fn> } }
    ).nodeGenerator.destroy;

    component.destroy();

    expect(nodeDestroy).toHaveBeenCalledTimes(1);
  });
});

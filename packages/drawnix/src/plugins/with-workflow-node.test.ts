/**
 * with-workflow-node 插件单测:删除片段级联
 *
 * 回归守护:drawnix 删除管线是「各插件把自己类型的选中元素 push 进
 * getDeletedFragment 的 data」(with-image-generation-anchor / with-draw 等皆是),
 * 工作流节点插件必须把选中的节点本身 push 进去,再级联其出/入连线——
 * 漏 push 节点本身会导致 deleteFragment(board) 静默无操作(节点删不掉)。
 */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaitBoard, PlaitElement } from '@plait/core';
import { withWorkflowNode } from './with-workflow-node';
import type { PlaitWorkflowNode } from '../types/workflow-node.types';

const { getSelectedElementsMock, addOrCreateClipboardContextMock } = vi.hoisted(
  () => ({
    getSelectedElementsMock: vi.fn(),
    addOrCreateClipboardContextMock: vi.fn(),
  })
);

vi.mock('@plait/core', () => ({
  addOrCreateClipboardContext: addOrCreateClipboardContextMock,
  addSelectedElement: vi.fn(),
  clearSelectedElement: vi.fn(),
  getSelectedElements: getSelectedElementsMock,
  idCreator: vi.fn(() => 'id-' + Math.random().toString(36).slice(2, 8)),
  RectangleClient: {
    getRectangleByPoints: vi.fn((points: [number[], number[]]) => ({
      x: points[0][0],
      y: points[0][1],
      width: points[1][0] - points[0][0],
      height: points[1][1] - points[0][1],
    })),
  },
  Selection: {},
  Transforms: {
    insertNode: vi.fn(),
  },
  WritableClipboardOperationType: {
    copy: 'copy',
    cut: 'cut',
    paste: 'paste',
    duplicate: 'duplicate',
  },
  WritableClipboardType: {
    elements: 'elements',
  },
}));

vi.mock('@plait/draw', () => ({
  PlaitDrawElement: {
    isArrowLine: vi.fn(
      (element: { type?: string }) => element.type === 'arrowLine'
    ),
  },
}));

vi.mock('../components/workflow-node-element/workflow-node.component', () => ({
  WorkflowNodeComponent: {},
}));

function makeWorkflowNode(
  id: string,
  nodeType: PlaitWorkflowNode['nodeType'] = 'image-generation'
): PlaitWorkflowNode {
  return {
    id,
    type: 'workflow-node',
    nodeType,
    params: {},
    points: [
      [0, 0],
      [220, 120],
    ],
  } as PlaitWorkflowNode;
}

function makeConnection(id: string, source: string, target: string) {
  return {
    id,
    type: 'arrowLine',
    workflowFlow: true,
    wfSource: source,
    wfTarget: target,
    wfSourcePort: 'outputs:images',
    wfTargetPort: 'inputs:referenceImages',
    points: [
      [0, 0],
      [10, 10],
    ],
  };
}

function createBoard(children: PlaitElement[]): PlaitBoard &
  Record<string, (...args: unknown[]) => unknown> {
  return {
    children,
    drawElement: vi.fn(),
    getRectangle: vi.fn(),
    isHit: vi.fn(),
    isRectangleHit: vi.fn(),
    isMovable: vi.fn(),
    isAlign: vi.fn(),
    getDeletedFragment: vi.fn((data: PlaitElement[]) => data),
    buildFragment: vi.fn(),
    insertFragment: vi.fn(),
  } as unknown as PlaitBoard & Record<string, (...args: unknown[]) => unknown>;
}

describe('withWorkflowNode getDeletedFragment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('选中的工作流节点本身必须进入待删片段(回归:节点无法删除)', () => {
    const node = makeWorkflowNode('wf-1');
    const board = createBoard([node]);
    withWorkflowNode(board);

    getSelectedElementsMock.mockReturnValue([node]);
    const data: PlaitElement[] = [];
    const result = board.getDeletedFragment(data);

    expect(result).toContain(node);
  });

  it('删除节点时级联其出/入数据流连线', () => {
    const node = makeWorkflowNode('wf-1');
    const target = makeWorkflowNode('wf-2', 'save-library');
    const conn = makeConnection('conn-1', 'wf-1', 'wf-2');
    const board = createBoard([node, target, conn]);
    withWorkflowNode(board);

    getSelectedElementsMock.mockReturnValue([node]);
    const data: PlaitElement[] = [];
    const result = board.getDeletedFragment(data);

    expect(result).toContain(node);
    expect(result).toContain(conn);
    expect(result).not.toContain(target);
  });

  it('未选中工作流节点时不改动片段数据', () => {
    const geometry = { id: 'geo-1', type: 'geometry' };
    const board = createBoard([geometry]);
    withWorkflowNode(board);

    getSelectedElementsMock.mockReturnValue([]);
    const data: PlaitElement[] = [];
    const result = board.getDeletedFragment(data);

    expect(result).toBe(data);
    expect(result).toHaveLength(0);
  });
});

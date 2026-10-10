/**
 * 工作流节点/连线 变换集合:插入、参数更新、状态清理。
 * 全部走 Plait Transforms(进画板撤销/重做与云同步体系)。
 */
import {
  idCreator,
  PlaitBoard,
  PlaitElement,
  Point,
  RectangleClient,
  Transforms,
} from '@plait/core';
import {
  ArrowLineMarkerType,
  ArrowLineShape,
  PlaitDrawElement,
} from '@plait/draw';
import { createArrowLineElement } from '@plait/draw';
import type {
  PlaitWorkflowConnection,
  PlaitWorkflowNode,
} from '../types/workflow-node.types';
import {
  isWorkflowConnectionElement,
  isWorkflowNodeElement,
  WORKFLOW_NODE_DEFAULT_HEIGHT,
  WORKFLOW_NODE_DEFAULT_WIDTH,
} from '../types/workflow-node.types';
import type { OrchestratorNodeTypeName } from '../services/workflow-orchestrator/graph-schema';
import { getViewportOrigination } from '@plait/core';

export class WorkflowNodeTransforms {
  /** 插入工作流节点(point 为左上角;缺省落在视口中心附近) */
  static insertWorkflowNode(
    board: PlaitBoard,
    nodeType: OrchestratorNodeTypeName,
    point?: Point
  ): PlaitWorkflowNode {
    const origin = point ?? this.defaultInsertPoint(board);
    const element: PlaitWorkflowNode = {
      id: idCreator(),
      type: 'workflow-node',
      nodeType,
      params: {},
      points: [
        origin,
        [
          origin[0] + WORKFLOW_NODE_DEFAULT_WIDTH,
          origin[1] + WORKFLOW_NODE_DEFAULT_HEIGHT,
        ],
      ],
    };
    Transforms.insertNode(board, element, [board.children.length]);
    return element;
  }

  /** 在两个工作流节点间插入数据流连线(箭头线绑定双方,自动跟随移动) */
  static insertWorkflowConnection(
    board: PlaitBoard,
    source: PlaitWorkflowNode,
    target: PlaitWorkflowNode,
    sourcePort: string,
    targetPort: string
  ): PlaitWorkflowConnection | null {
    if (source.id === target.id) return null;
    const sourceRect = RectangleClient.getRectangleByPoints(source.points);
    const targetRect = RectangleClient.getRectangleByPoints(target.points);
    const startPoint: Point = [
      sourceRect.x + sourceRect.width,
      sourceRect.y + sourceRect.height / 2,
    ];
    const endPoint: Point = [targetRect.x, targetRect.y + targetRect.height / 2];
    const base = createArrowLineElement(
      ArrowLineShape.straight,
      [startPoint, endPoint],
      { marker: ArrowLineMarkerType.none, boundId: source.id },
      { marker: ArrowLineMarkerType.arrow, boundId: target.id },
      [],
      {}
    );
    // 数据流语义字段:以附加属性挂在箭头线元素上(plait 元素支持额外字段透传)
    const element = {
      ...base,
      workflowFlow: true,
      wfSource: source.id,
      wfTarget: target.id,
      wfSourcePort: sourcePort,
      wfTargetPort: targetPort,
    } as unknown as PlaitWorkflowConnection;
    Transforms.insertNode(board, element, [board.children.length]);
    return element;
  }

  /** 更新节点参数字段 */
  static setParam(
    board: PlaitBoard,
    element: PlaitWorkflowNode,
    key: string,
    value: unknown
  ): void {
    const index = board.children.findIndex((child) => child.id === element.id);
    if (index < 0) return;
    Transforms.setNode(
      board,
      { params: { ...element.params, [key]: value } } as Partial<PlaitElement>,
      [index]
    );
  }

  /** 删除节点及其全部出/入连线 */
  static deleteWorkflowNodeWithConnections(board: PlaitBoard, nodeId: string): void {
    const bound = board.children.filter(
      (child) =>
        isWorkflowConnectionElement(child as PlaitElement) &&
        ((child as unknown as PlaitWorkflowConnection).source === nodeId ||
          (child as unknown as PlaitWorkflowConnection).target === nodeId)
    );
    const nodeIndex = board.children.findIndex((child) => child.id === nodeId);
    if (bound.length > 0) {
      const indices = bound
        .map((c) => board.children.indexOf(c as PlaitElement))
        .sort((x, y) => y - x);
      for (const idx of indices) {
        Transforms.removeNode(board, [idx]);
      }
    }
    if (nodeIndex >= 0) {
      Transforms.removeNode(board, [nodeIndex]);
    }
  }

  private static defaultInsertPoint(board: PlaitBoard): Point {
    const origination = getViewportOrigination(board);
    return [
      (origination?.[0] ?? 0) + 200 + Math.round(Math.random() * 120),
      (origination?.[1] ?? 0) + 160 + Math.round(Math.random() * 120),
    ];
  }
}

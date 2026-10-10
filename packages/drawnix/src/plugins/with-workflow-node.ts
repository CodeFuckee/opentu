/**
 * 工作流节点插件:workflow-node 元素接入画布体系
 * (选中/命中/框选/对齐/移动/复制粘贴/删除级联),渲染走 React foreignObject。
 */
import {
  addOrCreateClipboardContext,
  addSelectedElement,
  clearSelectedElement,
  getSelectedElements,
  idCreator,
  PlaitBoard,
  PlaitElement,
  PlaitPlugin,
  PlaitPluginElementContext,
  Point,
  RectangleClient,
  Selection,
  Transforms,
  WritableClipboardOperationType,
  WritableClipboardType,
} from '@plait/core';
import { WorkflowNodeComponent } from '../components/workflow-node-element/workflow-node.component';
import {
  isWorkflowConnectionElement,
  isWorkflowNodeElement,
  type PlaitWorkflowConnection,
  type PlaitWorkflowNode,
} from '../types/workflow-node.types';

function isRectIntersect(
  rect1: { x: number; y: number; width: number; height: number },
  rect2: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    rect1.x < rect2.x + rect2.width &&
    rect1.x + rect1.width > rect2.x &&
    rect1.y < rect2.y + rect2.height &&
    rect1.y + rect1.height > rect2.y
  );
}

export const withWorkflowNode: PlaitPlugin = (board: PlaitBoard) => {
  const {
    drawElement,
    getRectangle,
    isHit,
    isRectangleHit,
    isMovable,
    isAlign,
    getDeletedFragment,
    buildFragment,
    insertFragment,
  } = board;

  board.drawElement = (context: PlaitPluginElementContext) => {
    if (isWorkflowNodeElement(context.element)) {
      return WorkflowNodeComponent;
    }
    return drawElement(context);
  };

  board.getRectangle = (element: PlaitElement) => {
    if (isWorkflowNodeElement(element)) {
      return RectangleClient.getRectangleByPoints(element.points);
    }
    return getRectangle(element);
  };

  board.isHit = (element: PlaitElement, point: Point, isStrict?: boolean) => {
    if (isWorkflowNodeElement(element)) {
      const rect = RectangleClient.getRectangleByPoints(element.points);
      return (
        point[0] >= rect.x &&
        point[0] <= rect.x + rect.width &&
        point[1] >= rect.y &&
        point[1] <= rect.y + rect.height
      );
    }
    return isHit(element, point, isStrict);
  };

  board.isRectangleHit = (element: PlaitElement, selection: Selection) => {
    if (isWorkflowNodeElement(element)) {
      const rect = RectangleClient.getRectangleByPoints(element.points);
      const selectionRect = RectangleClient.getRectangleByPoints([
        selection.anchor,
        selection.focus,
      ]);
      return isRectIntersect(rect, selectionRect);
    }
    return isRectangleHit(element, selection);
  };

  board.isMovable = (element: PlaitElement) => {
    if (isWorkflowNodeElement(element)) return true;
    return isMovable(element);
  };

  board.isAlign = (element: PlaitElement) => {
    if (isWorkflowNodeElement(element)) return true;
    return isAlign(element);
  };

  // 删除工作流节点时,级联删除其出/入数据流连线
  board.getDeletedFragment = (data: PlaitElement[]) => {
    const selectedNodes = getSelectedElements(board).filter(
      isWorkflowNodeElement
    );
    if (selectedNodes.length > 0) {
      const nodeIds = new Set(selectedNodes.map((n) => n.id));
      const boundConnections = board.children.filter(
        (child) =>
          isWorkflowConnectionElement(child as PlaitElement) &&
          (nodeIds.has((child as unknown as PlaitWorkflowConnection).wfSource) ||
            nodeIds.has((child as unknown as PlaitWorkflowConnection).wfTarget))
      );
      data.push(...boundConnections);
    }
    return getDeletedFragment(data);
  };

  board.buildFragment = (clipboardContext: any, rectangle: any, operationType: any, originData?: PlaitElement[]) => {
    const targetElements =
      originData?.length ? originData : getSelectedElements(board);
    const workflowNodes = targetElements.filter(isWorkflowNodeElement) as PlaitWorkflowNode[];
    const workflowConnections = targetElements.filter(
      isWorkflowConnectionElement
    ) as PlaitWorkflowConnection[];

    if ((workflowNodes.length > 0 || workflowConnections.length > 0) && rectangle) {
      const relativeElements = [
        ...workflowNodes.map((node) => ({
          ...node,
          points: node.points.map((point) => [
            point[0] - rectangle.x,
            point[1] - rectangle.y,
          ]) as [Point, Point],
        })),
        ...workflowConnections,
      ];
      clipboardContext = addOrCreateClipboardContext(clipboardContext, {
        text: '',
        type: WritableClipboardType.elements,
        elements: relativeElements,
      });
    }

    return buildFragment(clipboardContext, rectangle, operationType, originData);
  };

  (board as unknown as Record<string, unknown>).insertFragment = (
    clipboardData: any,
    targetPoint: Point,
    operationType: WritableClipboardOperationType
  ) => {
    const clipboardElements: Array<Record<string, unknown>> =
      clipboardData?.elements ?? [];
    const workflowElements = clipboardElements.filter(
      (el) =>
        (el as { type?: string }).type === 'workflow-node' ||
        isWorkflowConnectionElement(el as PlaitElement)
    );

    if (workflowElements.length > 0) {
      const idMap = new Map<string, string>();
      workflowElements.forEach((el) => {
        idMap.set(String(el.id), idCreator());
      });

      workflowElements.forEach((el) => {
        const newId = idMap.get(String(el.id))!;
        const points = (el.points as [Point, Point]).map((point) => [
          targetPoint[0] + point[0],
          targetPoint[1] + point[1],
        ]) as [Point, Point];
        const nextElement = {
          ...el,
          id: newId,
          points,
        };
        // 连线重映射到新节点 id(复制的图保持连通)
        if (isWorkflowConnectionElement(nextElement as PlaitElement)) {
          const conn = nextElement as unknown as PlaitWorkflowConnection;
          conn.source = idMap.get(conn.source) ?? conn.source;
          conn.target = idMap.get(conn.target) ?? conn.target;
        }
        Transforms.insertNode(board, nextElement as PlaitElement, [
          board.children.length,
        ]);
      });

      clearSelectedElement(board);
      workflowElements.forEach((el) => {
        const newId = idMap.get(String(el.id));
        const inserted = board.children.find((child) => child.id === newId);
        if (inserted) addSelectedElement(board, inserted);
      });
    }

    const rest = clipboardElements.length
      ? {
          ...clipboardData,
          elements: clipboardElements.filter(
            (el: Record<string, unknown>) =>
              (el as { type?: string }).type !== 'workflow-node' &&
              !isWorkflowConnectionElement(el as PlaitElement)
          ),
        }
      : clipboardData;

    insertFragment(rest as never, targetPoint, operationType);
  };

  return board;
};

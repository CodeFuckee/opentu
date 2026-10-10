/**
 * 工作流编排画布元素类型(主画布原生节点)
 *
 * 节点 = workflow-node 元素(参数即节点参数,几何即位置);
 * 连线 = plait-draw 箭头线元素 + workflowFlow 标记(绑定节点 id,
 * 移动节点时由 plait-draw 连接系统自动跟随,无第二数据副本)。
 */
import type { PlaitElement, Point } from '@plait/core';
import { PlaitDrawElement } from '@plait/draw';
import type { OrchestratorNodeTypeName } from '../services/workflow-orchestrator/graph-schema';

export const WORKFLOW_NODE_DEFAULT_WIDTH = 220;
export const WORKFLOW_NODE_DEFAULT_HEIGHT = 120;

export interface PlaitWorkflowNode extends PlaitElement {
  type: 'workflow-node';
  nodeType: OrchestratorNodeTypeName;
  params: Record<string, unknown>;
  points: [Point, Point];
}

export interface WorkflowConnectionMeta {
  /** 数据流标记(区分普通箭头线) */
  workflowFlow: true;
  wfSource: string;
  wfTarget: string;
  wfSourcePort: string;
  wfTargetPort: string;
}

export type PlaitWorkflowConnection = PlaitDrawElement & WorkflowConnectionMeta;

export function isWorkflowNodeElement(
  element: PlaitElement
): element is PlaitWorkflowNode {
  return (element as PlaitWorkflowNode).type === 'workflow-node';
}

export function isWorkflowConnectionElement(
  element: PlaitElement
): element is PlaitWorkflowConnection {
  return (
    PlaitDrawElement.isArrowLine(element) &&
    (element as unknown as WorkflowConnectionMeta).workflowFlow === true
  );
}

/** 读取连线的数据流端点(箭头线元素附加字段) */
export function getConnectionEnds(element: PlaitWorkflowConnection): {
  source: string;
  target: string;
} {
  return { source: element.wfSource, target: element.wfTarget };
}

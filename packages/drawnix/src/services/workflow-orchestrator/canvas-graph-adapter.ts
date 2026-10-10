/**
 * 画布 ↔ 编排图 双向适配(纯函数)。
 *
 * 画布元素(workflow-node + workflowFlow 箭头线)是唯一数据源;
 * 本模块把它们实时派生为 M1 的 OrchestratorGraph,编译/执行全部复用。
 */
import { PlaitBoard, PlaitElement, Point, RectangleClient } from '@plait/core';
import {
  isWorkflowConnectionElement,
  isWorkflowNodeElement,
  type PlaitWorkflowConnection,
  type PlaitWorkflowNode,
} from '../../types/workflow-node.types';
import type { OrchestratorNode } from './graph-schema';
import type { OrchestratorGraph } from './graph-schema';

export interface WorkflowGroup {
  id: string;
  name: string;
  graph: OrchestratorGraph;
}

/** 画布上的全部工作流节点与连线 */
export function getWorkflowElements(board: PlaitBoard): {
  nodes: PlaitWorkflowNode[];
  connections: PlaitWorkflowConnection[];
} {
  const nodes: PlaitWorkflowNode[] = [];
  const connections: PlaitWorkflowConnection[] = [];
  for (const child of board.children as PlaitElement[]) {
    if (isWorkflowNodeElement(child)) nodes.push(child);
    else if (isWorkflowConnectionElement(child)) connections.push(child);
  }
  return { nodes, connections };
}

/** 连通图划分:互不相连的节点簇各自为一个工作流 */
function groupNodeIds(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>
): string[][] {
  const parent = new Map<string, string>(nodeIds.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    const path: string[] = [];
    let cur = id;
    while (parent.get(cur) !== cur) {
      path.push(cur);
      cur = root;
    }
    for (const p of path) parent.set(p, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of edges) {
    if (parent.has(e.source) && parent.has(e.target)) union(e.source, e.target);
  }
  const groups = new Map<string, string[]>();
  for (const id of nodeIds) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id);
  }
  return [...groups.values()];
}

/**
 * 收集画布上的全部工作流(按连通图划分)。
 * 每组返回派生的 OrchestratorGraph(可直接交给 compileGraph)。
 */
export function collectWorkflowGraphs(board: PlaitBoard): WorkflowGroup[] {
  const { nodes, connections } = getWorkflowElements(board);
  if (nodes.length === 0) return [];

  // 找出连线源头指向的画布图片元素(作为参考图输入源,虚拟为 reference-image 节点)
  const nodeIds = new Set(nodes.map((n) => n.id));
  const imageSources = new Map<string, PlaitElement>();
  for (const conn of connections) {
    if (
      !nodeIds.has(conn.wfSource) &&
      !imageSources.has(conn.wfSource)
    ) {
      const sourceEl = (board.children as PlaitElement[]).find(
        (child) => child.id === conn.wfSource
      );
      if (
        sourceEl &&
        (sourceEl as { type?: string }).type === 'image' &&
        (sourceEl as { url?: string }).url
      ) {
        imageSources.set(conn.wfSource, sourceEl);
      }
    }
  }

  // 图片源元素虚拟为 reference-image 节点加入图
  const allNodes: Array<OrchestratorNode & { id: string }> = [
    ...nodes.map((n) => ({
      id: n.id,
      type: n.nodeType,
      params: { ...n.params },
      geometry: {
        x: RectangleClient.getRectangleByPoints(n.points).x,
        y: RectangleClient.getRectangleByPoints(n.points).y,
      },
    })),
    ...[...imageSources.entries()].map(([id, el]) => ({
      id,
      type: 'reference-image' as const,
      params: { url: (el as { url?: string }).url ?? '' },
      geometry: {
        x: RectangleClient.getRectangleByPoints(el.points as Point[]).x,
        y: RectangleClient.getRectangleByPoints(el.points as Point[]).y,
      },
    })),
  ];

  const allNodeIds = allNodes.map((n) => n.id);

  const validConnections = connections.filter((c) => {
    const sourceExists = allNodeIds.includes(c.wfSource);
    const targetExists = allNodeIds.includes(c.wfTarget);
    return sourceExists && targetExists;
  });

  const edges = validConnections.map((c) => ({
    id: `${c.id}:${c.wfSource}->${c.wfTarget}`,
    source: c.wfSource,
    target: c.wfTarget,
    sourcePort: c.wfSourcePort,
    targetPort: c.wfTargetPort,
  }));
  const groups = groupNodeIds(allNodeIds, edges);

  return groups.map((nodeIds) => {
    const idSet = new Set(nodeIds);
    const groupNodes: OrchestratorNode[] = allNodes
      .filter((n) => idSet.has(n.id))
      .map((n) => ({
        id: n.id,
        type: n.type,
        params: { ...n.params },
        geometry: { ...n.geometry },
      }));
    const groupEdges = edges.filter(
      (e) => idSet.has(e.source) && idSet.has(e.target)
    );
    const sortedIds = [...nodeIds].sort();
    const graph: OrchestratorGraph = {
      id: `canvas_${sortedIds[0]}`,
      name: `画布工作流(${nodeIds.length} 节点)`,
      schemaVersion: 1,
      nodes: groupNodes,
      edges: groupEdges,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return {
      id: graph.id,
      name: graph.name,
      graph,
    };
  });
}

/** 某节点的全部上游(反向闭包,不含自身) */
export function getUpstreamNodeIds(
  graph: OrchestratorGraph,
  nodeId: string
): Set<string> {
  const upstream = new Set<string>();
  const edges = graph.edges;
  const walk = (id: string) => {
    for (const e of edges) {
      if (e.target === id && !upstream.has(e.source)) {
        upstream.add(e.source);
        walk(e.source);
      }
    }
  };
  walk(nodeId);
  return upstream;
}

/** 节点右缘 + 40 的落图起点(自动落节点旁) */
export function getDropPointBesideNode(
  board: PlaitBoard,
  nodeId: string
): [number, number] {
  const element = (board.children as PlaitElement[]).find(
    (child) => child.id === nodeId
  );
  if (element && isWorkflowNodeElement(element)) {
    const rect = RectangleClient.getRectangleByPoints(element.points);
    return [rect.x + rect.width + 40, rect.y];
  }
  return [0, 0];
}

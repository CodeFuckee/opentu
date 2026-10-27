/**
 * Flowgram 文档 ↔ OrchestratorGraph 双向转换(纯函数)
 *
 * Flowgram free-layout 的文档结构(WorkflowJSON)与本仓编排图几乎一一对应:
 * - 节点:{ id, type, data(表单/参数), meta.position }  ←→  { id, type, params, geometry }
 * - 连线:{ sourceNodeID, targetNodeID, sourcePortID?, targetPortID? } ←→
 *         { id, source, sourcePort, target, targetPort }
 *
 * 端口 id 沿用编译器的 `inputs:xxx` / `outputs:xxx` 原文(单一事实源是
 * graph-compiler 的 NODE_TYPE_SPECS),转换层不做翻译。
 *
 * 本文件刻意不 import @flowgram.ai/*:services 层保持零 flowgram 依赖,
 * 此处用结构性类型描述 Flowgram 文档(与 WorkflowJSON 兼容)。
 */
import { idCreator } from '@plait/core';
import type {
  OrchestratorEdge,
  OrchestratorGraph,
  OrchestratorNode,
} from './graph-schema';
import { createEmptyGraph, ORCHESTRATOR_GRAPH_SCHEMA_VERSION } from './graph-schema';
import { NODE_TYPE_SPECS } from './graph-compiler';

/** Flowgram 节点 JSON(WorkflowNodeJSON 的结构子集) */
export interface FlowgramNodeJSON {
  id: string;
  type: string;
  /** 表单数据 → OrchestratorNode.params */
  data?: Record<string, unknown>;
  meta?: {
    position?: { x: number; y: number };
  };
}

/** Flowgram 连线 JSON(WorkflowEdgeJSON 的结构子集) */
export interface FlowgramEdgeJSON {
  sourceNodeID: string;
  targetNodeID: string;
  sourcePortID?: string | number;
  targetPortID?: string | number;
}

/** Flowgram 文档 JSON(WorkflowJSON 的结构子集) */
export interface FlowgramDocumentJSON {
  nodes: FlowgramNodeJSON[];
  edges: FlowgramEdgeJSON[];
}

/** OrchestratorGraph → Flowgram 文档(进编辑器;保留未知类型节点,连线原样透传) */
export function toFlowgramDocument(graph: OrchestratorGraph): FlowgramDocumentJSON {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      data: { ...node.params },
      meta: {
        position: { x: node.geometry.x, y: node.geometry.y },
      },
    })),
    edges: graph.edges.map((edge) => ({
      sourceNodeID: edge.source,
      targetNodeID: edge.target,
      sourcePortID: edge.sourcePort,
      targetPortID: edge.targetPort,
    })),
  };
}

/**
 * Flowgram 文档 → OrchestratorGraph(出编辑器;在 base 上刷新 updatedAt)
 *
 * 防御性丢弃两类脏数据:
 * - 未知节点类型(编辑器无注册、无法编译;实践中 schema v1 不出现)
 * - 缺端口 id 的连线(编译器要求显式端口)
 */
export function fromFlowgramDocument(
  doc: FlowgramDocumentJSON,
  base: Pick<OrchestratorGraph, 'id' | 'name' | 'createdAt'>
): OrchestratorGraph {
  const graph = createEmptyGraph(base.name || '未命名工作流');
  graph.id = base.id;
  graph.createdAt = base.createdAt;
  graph.schemaVersion = ORCHESTRATOR_GRAPH_SCHEMA_VERSION;

  const knownIds = new Set<string>();
  for (const node of Array.isArray(doc?.nodes) ? doc.nodes : []) {
    if (!node || typeof node.id !== 'string' || !node.id) continue;
    if (!(node.type in NODE_TYPE_SPECS)) continue;
    knownIds.add(node.id);
    const params =
      node.data && typeof node.data === 'object' && !Array.isArray(node.data)
        ? { ...node.data }
        : {};
    const position = node.meta?.position;
    const orchestratorNode: OrchestratorNode = {
      id: node.id,
      type: node.type as OrchestratorNode['type'],
      params,
      geometry: {
        x: typeof position?.x === 'number' ? position.x : 0,
        y: typeof position?.y === 'number' ? position.y : 0,
      },
    };
    graph.nodes.push(orchestratorNode);
  }

  for (const edge of Array.isArray(doc?.edges) ? doc.edges : []) {
    if (!edge) continue;
    const sourcePort = normalizePortId(edge.sourcePortID);
    const targetPort = normalizePortId(edge.targetPortID);
    if (!sourcePort || !targetPort) continue;
    if (!knownIds.has(edge.sourceNodeID) || !knownIds.has(edge.targetNodeID)) continue;
    const orchestratorEdge: OrchestratorEdge = {
      id: `wfe_${idCreator().slice(-8)}`,
      source: edge.sourceNodeID,
      sourcePort,
      target: edge.targetNodeID,
      targetPort,
    };
    graph.edges.push(orchestratorEdge);
  }

  graph.updatedAt = Date.now();
  return graph;
}

function normalizePortId(portId: string | number | undefined): string | null {
  if (typeof portId === 'string' && portId) return portId;
  if (typeof portId === 'number') return String(portId);
  return null;
}

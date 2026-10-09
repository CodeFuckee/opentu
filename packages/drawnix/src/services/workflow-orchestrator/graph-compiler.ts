/**
 * 图编译器:编排节点图 → WorkflowEngine 步骤数组
 *
 * 职责:
 * - 校验:未知节点类型/节点数上限/连线端点存在性/端口存在性与类型匹配/环检测/
 *   生成节点缺 prompt
 * - 静态内联:直通节点(提示词/参考图/模型参数)的面板值编译期内联进生成节点 args
 * - 运行时占位符:生成节点输出 → 下游输入的数据边,编译为 `{{stepId.field}}`
 *   占位符(引擎执行到该步骤时从上游 step.result 解析,见 workflow-engine 的
 *   resolveStepArgs)
 *
 * 纯函数,无副作用;所有失败以 CompilerError 抛出(带中文定位信息)。
 */

import type { WorkflowStep } from '../workflow-engine/types';
import {
  MAX_GRAPH_NODES,
  type OrchestratorEdge,
  type OrchestratorGraph,
  type OrchestratorNode,
} from './graph-schema';

/** 端口数据类型 */
export type PortKind = 'text' | 'model' | 'image' | 'image[]';

export interface PortDef {
  id: string;
  kind: PortKind;
  label: string;
}

export interface NodeTypeSpec {
  inputs: PortDef[];
  outputs: PortDef[];
  /** 直通节点:不产生执行步骤,面板值编译期内联进下游 */
  passThrough: boolean;
}

const TEXT_OUT: PortDef = { id: 'outputs:text', kind: 'text', label: '文本' };
const IMAGE_OUT_ONE: PortDef = { id: 'outputs:image', kind: 'image', label: '图片' };
const MODEL_OUT: PortDef = { id: 'outputs:model', kind: 'model', label: '模型参数' };
const IMAGES_OUT: PortDef = { id: 'outputs:images', kind: 'image[]', label: '图片组' };
const IN_PROMPT: PortDef = { id: 'inputs:prompt', kind: 'text', label: '提示词' };
const IN_MODEL: PortDef = { id: 'inputs:model', kind: 'model', label: '模型参数' };
const IN_REF_IMAGES: PortDef = { id: 'inputs:referenceImages', kind: 'image[]', label: '参考图' };
const IN_IMAGES: PortDef = { id: 'inputs:images', kind: 'image[]', label: '图片组' };

/** M1 节点类型注册数据(UI 组件映射见 components/workflow-orchestrator/node-registry) */
export const NODE_TYPE_SPECS: Record<string, NodeTypeSpec> = {
  prompt: { inputs: [], outputs: [TEXT_OUT], passThrough: true },
  'reference-image': { inputs: [], outputs: [IMAGE_OUT_ONE], passThrough: true },
  'model-picker': { inputs: [], outputs: [MODEL_OUT], passThrough: true },
  'image-generation': {
    inputs: [IN_PROMPT, IN_MODEL, IN_REF_IMAGES],
    outputs: [IMAGES_OUT],
    passThrough: false,
  },
  'image-variation': {
    inputs: [IN_PROMPT, IN_REF_IMAGES],
    outputs: [IMAGES_OUT],
    passThrough: false,
  },
  'insert-canvas': { inputs: [IN_IMAGES], outputs: [], passThrough: false },
  'save-library': { inputs: [IN_IMAGES], outputs: [], passThrough: false },
  preview: { inputs: [IN_IMAGES], outputs: [], passThrough: true },
};

export class CompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompilerError';
  }
}

export interface CompiledWorkflow {
  steps: Omit<WorkflowStep, 'status'>[];
  /** stepId → 源节点 id(本编译器 stepId 即 nodeId) */
  stepNodeIds: Record<string, string>;
}

interface PortRef {
  nodeId: string;
  port: PortDef;
}

function parsePortRef(
  nodes: Map<string, OrchestratorNode>,
  edge: OrchestratorEdge,
  side: 'source' | 'target'
): PortRef {
  const nodeId = side === 'source' ? edge.source : edge.target;
  const portId = side === 'source' ? edge.sourcePort : edge.targetPort;
  const node = nodes.get(nodeId);
  if (!node) {
    throw new CompilerError(
      `连线 ${edge.id} 引用了不存在的节点「${nodeId}」`
    );
  }
  const spec = NODE_TYPE_SPECS[node.type];
  if (!spec) {
    throw new CompilerError(`未知节点类型:「${node.type}」(节点 ${nodeId})`);
  }
  const allPorts = [...spec.inputs, ...spec.outputs];
  const port = allPorts.find((pt) => pt.id === portId);
  if (!port) {
    throw new CompilerError(
      `连线 ${edge.id} 引用了节点 ${nodeId} 上不存在的端口「${portId}」`
    );
  }
  return { nodeId, port };
}

/** 端口类型兼容:单图可进图片组端口,其余必须同型 */
function isKindCompatible(source: PortKind, target: PortKind): boolean {
  if (source === target) return true;
  if (source === 'image' && target === 'image[]') return true;
  return false;
}

function detectCycle(
  nodes: Map<string, OrchestratorNode>,
  edges: OrchestratorEdge[]
): void {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source)!.push(e.target);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const dfs = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      throw new CompilerError(
        `节点图存在环(数据流闭环):${[...stack, nodeId].join(' → ')}。请断开形成环的连线`
      );
    }
    visiting.add(nodeId);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (nodes.has(next)) dfs(next);
    }
    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodes.keys()) dfs(nodeId);
}

/** 沿数据边向上游回溯,收集直通节点内联值与生成节点占位符 */
interface ResolvedInput {
  staticValues: Record<string, unknown>[];
  placeholders: { stepId: string; field: string }[];
}

function resolveInputPort(
  nodeId: string,
  inputPort: PortDef,
  edges: OrchestratorEdge[],
  nodes: Map<string, OrchestratorNode>,
  generatedStepIds: Map<string, string>
): ResolvedInput {
  const resolved: ResolvedInput = { staticValues: [], placeholders: [] };
  for (const edge of edges) {
    if (edge.target !== nodeId || edge.targetPort !== inputPort.id) continue;
    const sourceRef = parsePortRef(nodes, edge, 'source');
    const sourceNode = nodes.get(sourceRef.nodeId)!;
    const spec = NODE_TYPE_SPECS[sourceNode.type];
    if (spec.passThrough) {
      // 直通节点:面板值内联
      if (sourceNode.type === 'prompt') {
        resolved.staticValues.push({ text: sourceNode.params.text });
      } else if (sourceNode.type === 'reference-image') {
        resolved.staticValues.push({ url: sourceNode.params.url });
      } else if (sourceNode.type === 'model-picker') {
        resolved.staticValues.push({ ...sourceNode.params });
      }
    } else {
      // 生成节点:运行时占位符(引擎从上游 step.result 解析)
      const stepId = generatedStepIds.get(sourceRef.nodeId);
      if (stepId) {
        const field = inputPort.kind === 'image[]' ? 'urls' : 'url';
        resolved.placeholders.push({ stepId, field });
      }
    }
  }
  return resolved;
}

export function compileGraph(graph: OrchestratorGraph): CompiledWorkflow {
  // 图输入做一次深拷贝隔离(调用方常直接传存储对象)
  const input = JSON.parse(JSON.stringify(graph)) as GraphInput;
  const nodes = new Map<string, OrchestratorNode>();
  for (const node of input.nodes) {
    if (!NODE_TYPE_SPECS[node.type]) {
      throw new CompilerError(`未知节点类型:「${node.type}」(节点 ${node.id})`);
    }
    nodes.set(node.id, node);
  }
  if (nodes.size > MAX_GRAPH_NODES) {
    throw new CompilerError(
      `节点数超过上限(${MAX_GRAPH_NODES}):当前 ${nodes.size} 个`
    );
  }

  for (const edge of input.edges) {
    const source = parsePortRef(nodes, edge, 'source');
    const target = parsePortRef(nodes, edge, 'target');
    if (!isKindCompatible(source.port.kind, target.port.kind)) {
      throw new CompilerError(
        `连线 ${edge.id} 端口类型不匹配:${source.port.kind} → ${target.port.kind}`
      );
    }
  }
  detectCycle(nodes, input.edges);

  // 第一遍:为所有生成节点分配 stepId(即 nodeId),供占位符引用
  const generatedStepIds = new Map<string, string>();
  for (const node of nodes.values()) {
    const spec = NODE_TYPE_SPECS[node.type];
    if (!spec.passThrough) {
      generatedStepIds.set(node.id, node.id);
    }
  }

  // 第二遍:生成节点 → 步骤
  const steps: Omit<WorkflowStep, 'status'>[] = [];
  const stepNodeIds: Record<string, string> = {};

  for (const node of nodes.values()) {
    const spec = NODE_TYPE_SPECS[node.type];
    if (spec.passThrough) continue;

    // 收集各输入端口的解析结果
    const args: Record<string, unknown> = { ...node.params };
    const dependsOn: string[] = [];

    for (const inputPort of spec.inputs) {
      const resolved = resolveInputPort(
        node.id,
        inputPort,
        input.edges,
        nodes,
        generatedStepIds
      );

      if (inputPort.id === 'inputs:prompt') {
        const text = resolved.staticValues.find((v) => 'text' in v)?.text;
        if (typeof text === 'string' && text.trim()) args.prompt = text;
      } else if (inputPort.id === 'inputs:model') {
        const modelParams = resolved.staticValues.find(
          (v) => 'model' in v
        ) as Record<string, unknown> | undefined;
        if (modelParams) {
          if (modelParams.model) args.model = modelParams.model;
          if (modelParams.size) args.size = modelParams.size;
          if (modelParams.count) args.count = modelParams.count;
        }
      } else if (inputPort.id === 'inputs:referenceImages') {
        const staticUrls = resolved.staticValues
          .map((v) => ('url' in v ? (v.url as string) : undefined))
          .filter((u): u is string => !!u);
        if (staticUrls.length > 0) {
          args.referenceImages = staticUrls;
        } else if (resolved.placeholders.length > 0) {
          // 运行时占位符:引擎执行时从上游 result.urls 解析为数组
          args.referenceImages = `{{${resolved.placeholders[0].stepId}.urls}}`;
        }
      } else if (inputPort.id === 'inputs:images') {
        if (resolved.placeholders.length > 0) {
          args.urls = `{{${resolved.placeholders[0].stepId}.urls}}`;
          const upstreamStepId = resolved.placeholders[0].stepId;
          if (!dependsOn.includes(upstreamStepId)) dependsOn.push(upstreamStepId);
        }
      }
    }

    let step: Omit<WorkflowStep, 'status'> | null = null;
    if (node.type === 'image-generation') {
      if (!args.prompt) {
        throw new CompilerError(
          `生成节点「${node.id}」缺少提示词:请连接提示词节点或在参数面板填写`
        );
      }
      step = { id: node.id, mcp: 'generate_image', args, description: `文生图:${args.prompt as string}`, dependsOn };
    } else if (node.type === 'image-variation') {
      if (!args.prompt) {
        throw new CompilerError(
          `生成节点「${node.id}」缺少提示词:请连接提示词节点或在参数面板填写`
        );
      }
      args.generationMode = 'image_edit';
      step = { id: node.id, mcp: 'generate_image', args, description: `基于图生成:${args.prompt as string}`, dependsOn };
    } else if (node.type === 'save-library') {
      if (!args.urls) {
        throw new CompilerError(
          `存素材库节点「${node.id}」未连接图片输入`
        );
      }
      step = { id: node.id, mcp: 'archive_media', args, description: '存入素材库', dependsOn };
    } else if (node.type === 'insert-canvas') {
      if (!args.urls) {
        throw new CompilerError(
          `插入画布节点「${node.id}」未连接图片输入`
        );
      }
      step = { id: node.id, mcp: 'insert_images', args, description: '插入画布', dependsOn };
    }
    // preview 为 passThrough,不会进入此分支

    if (step) {
      steps.push(step);
      stepNodeIds[step.id] = node.id;
    }
  }

  return { steps, stepNodeIds };
}

/** GraphInput:compileGraph 接受宽松输入(存储读取后未迁移的形状也可) */
export type GraphInput = OrchestratorGraph;

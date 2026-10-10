/**
 * 工作流运行服务:画布编排的执行入口与运行态广播。
 *
 * - runAll(board):全部连通图各自编译执行
 * - runNode(board, nodeId):单节点及其上游
 * - 运行态(节点状态/错误)存内存并广播(不落元素,避免污染撤销栈);
 *   节点 React 内容通过 subscribe/useSyncExternalStore 订阅
 */
import { MessagePlugin } from '../../utils/message-plugin';
import { PlaitBoard, PlaitElement, Point, Transforms, idCreator } from '@plait/core';
import { ArrowLineMarkerType, ArrowLineShape, createArrowLineElement } from '@plait/draw';
import { WorkflowEngine } from '../workflow-engine/engine';
import { createWorkflow } from '../workflow-engine/workflow-factory';
import type { WorkflowEvent } from '../workflow-engine/types';
import { swCapabilitiesHandler } from '../sw-capabilities';
import type { DelegatedOperation } from '../sw-capabilities';
import { compileGraph, CompilerError } from './graph-compiler';
import {
  collectWorkflowGraphs,
  getDropPointBesideNode,
  getUpstreamNodeIds,
} from './canvas-graph-adapter';
import type { OrchestratorGraph, OrchestratorNodeTypeName } from './graph-schema';
import type { PlaitWorkflowNode } from '../../types/workflow-node.types';
import { getCapabilitiesBoard } from '../sw-capabilities';
import {
  WORKFLOW_NODE_DEFAULT_HEIGHT,
  WORKFLOW_NODE_DEFAULT_WIDTH,
} from '../../types/workflow-node.types';

export type WorkflowNodeRunStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface WorkflowRunSnapshot {
  version: number;
  statuses: Record<string, WorkflowNodeRunStatus>;
  errors: Record<string, string>;
  running: boolean;
}

type Listener = () => void;

class WorkflowRunService {
  private engine: WorkflowEngine | null = null;
  private statuses: Record<string, WorkflowNodeRunStatus> = {};
  private errors: Record<string, string> = {};
  private running = false;
  private version = 0;
  private listeners = new Set<Listener>();
  private currentRunIds = new Set<string>();
  // useSyncExternalStore 的快照必须引用稳定(否则无限重渲染,React #185)
  private snapshotCache: WorkflowRunSnapshot = {
    version: 0,
    statuses: {},
    errors: {},
    running: false,
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): WorkflowRunSnapshot => this.snapshotCache;

  private emit(): void {
    this.version += 1;
    this.snapshotCache = {
      version: this.version,
      statuses: { ...this.statuses },
      errors: { ...this.errors },
      running: this.running,
    };
    this.listeners.forEach((listener) => listener());
  }

  private setStatus(nodeId: string, status: WorkflowNodeRunStatus, error?: string): void {
    this.statuses[nodeId] = status;
    if (error) this.errors[nodeId] = error;
    this.emit();
  }

  /** 当前画布(AIInputBar 常驻注册;未初始化返回 null) */
  private get board(): PlaitBoard | null {
    return getCapabilitiesBoard();
  }

  /** 供面板读取画布(旧图导入需要) */
  getBoard(): PlaitBoard | null {
    return this.board;
  }

  /** 导入 M1 旧编排图到画布(节点/连线/参数,几何沿用) */
  importLegacyGraph(graph: OrchestratorGraph): boolean {
    const board = this.board;
    if (!board) {
      MessagePlugin.warning('画布未就绪');
      return false;
    }
    const idMap = new Map<string, string>();
    for (const node of graph.nodes) {
      const created = this.insertNode(node.type);
      if (!created) continue;
      idMap.set(node.id, created.id);
      const index = board.children.findIndex((c) => c.id === created.id);
      if (index >= 0) {
        const rectX = node.geometry.x;
        const rectY = node.geometry.y;
        Transforms.setNode(
          board,
          {
            params: { ...node.params },
            points: [
              [rectX, rectY],
              [rectX + WORKFLOW_NODE_DEFAULT_WIDTH, rectY + WORKFLOW_NODE_DEFAULT_HEIGHT],
            ],
          } as Partial<PlaitElement>,
          [index]
        );
      }
    }
    for (const edge of graph.edges) {
      const sourceIndex = board.children.findIndex(
        (c) => c.id === idMap.get(edge.source)
      );
      const targetIndex = board.children.findIndex(
        (c) => c.id === idMap.get(edge.target)
      );
      if (sourceIndex < 0 || targetIndex < 0) continue;
      const source = board.children[sourceIndex] as unknown as PlaitWorkflowNode;
      const target = board.children[targetIndex] as unknown as PlaitWorkflowNode;
      this.insertConnection(board, source, target, edge);
    }
    return true;
  }

  private insertConnection(
    board: PlaitBoard,
    source: PlaitWorkflowNode,
    target: PlaitWorkflowNode,
    edge: OrchestratorGraph['edges'][number]
  ): void {
    // 与 WorkflowNodeTransforms.insertWorkflowConnection 同构(直接实现避免循环依赖)
    const element = {
      ...(createArrowLineElement(
        ArrowLineShape.straight,
        [
          [source.points[1][0], source.points[0][1] + (source.points[1][1] - source.points[0][1]) / 2],
          [target.points[0][0], target.points[0][1] + (target.points[1][1] - target.points[0][1]) / 2],
        ] as [Point, Point],
        { marker: ArrowLineMarkerType.none, boundId: source.id },
        { marker: ArrowLineMarkerType.arrow, boundId: target.id },
        [],
        {}
      )),
      workflowFlow: true,
      wfSource: source.id,
      wfTarget: target.id,
      wfSourcePort: edge.sourcePort,
      wfTargetPort: edge.targetPort,
    } as unknown as PlaitElement;
    Transforms.insertNode(board, element, [board.children.length]);
  }

  /** 插入工作流节点到当前画布(面板「添加节点」) */
  insertNode(nodeType: OrchestratorNodeTypeName): PlaitWorkflowNode | null {
    const board = this.board;
    if (!board) {
      MessagePlugin.warning('画布未就绪,请稍后再试');
      return null;
    }
    const origination = (
      board as unknown as {
        viewport?: { origination?: [number, number] | null };
      }
    ).viewport?.origination;
    // 按已有工作流节点数递增偏移,避免新节点堆叠遮挡
    const existing = (board.children as PlaitElement[]).filter(
      (child) => (child as { type?: string }).type === 'workflow-node'
    ).length;
    const baseX = (origination?.[0] ?? 0) + 160 + (existing % 4) * 280;
    const baseY = (origination?.[1] ?? 0) + 140 + Math.floor(existing / 4) * 200;
    const element: PlaitWorkflowNode = {
      id: idCreator(),
      type: 'workflow-node',
      nodeType,
      params: {},
      points: [
        [baseX, baseY],
        [baseX + WORKFLOW_NODE_DEFAULT_WIDTH, baseY + WORKFLOW_NODE_DEFAULT_HEIGHT],
      ],
    };
    Transforms.insertNode(board, element, [board.children.length]);
    return element;
  }

  private ensureEngine(board: PlaitBoard): WorkflowEngine {
    if (!this.engine) {
      this.engine = new WorkflowEngine({
        onEvent: (event: WorkflowEvent) => this.handleEvent(event),
        executeMainThreadTool: async (toolName: string, args: Record<string, unknown>) => {
          try {
            const result = await swCapabilitiesHandler.execute({
              operation: toolName,
              args,
            } as DelegatedOperation);
            return { success: result.success, error: result.error };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : '主线程工具执行失败',
            };
          }
        },
      });
    }
    return this.engine;
  }

  private handleEvent(event: WorkflowEvent): void {
    if (event.type === 'step') {
      const status = (event.status ?? 'completed') as WorkflowNodeRunStatus;
      const error = event.error;
      this.setStatus(event.stepId, status, error);
    } else if (event.type === 'completed') {
      this.currentRunIds.delete(event.workflowId);
      if (this.currentRunIds.size === 0) {
        this.running = false;
        this.emit();
        MessagePlugin.success('工作流执行完成');
      }
    } else if (event.type === 'failed') {
      this.currentRunIds.delete(event.workflowId);
      this.running = false;
      this.emit();
      MessagePlugin.error(`工作流执行失败:${event.error}`);
    }
  }

  /** 输出节点生成图自动落「源节点右侧」:提交前注入落图起点 */
  private attachDropStartPoints(
    board: PlaitBoard,
    graph: OrchestratorGraph,
    steps: ReturnType<typeof compileGraph>['steps']
  ): void {
    for (const step of steps) {
      if (step.mcp !== 'insert_images') continue;
      const sourceEdge = graph.edges.find((e) => e.target === step.id);
      if (!sourceEdge) continue;
      step.args.startPoint = getDropPointBesideNode(board, sourceEdge.source);
    }
  }

  private submitSteps(
    board: PlaitBoard,
    name: string,
    graph: OrchestratorGraph,
    steps: ReturnType<typeof compileGraph>['steps']
  ): void {
    this.attachDropStartPoints(board, graph, steps);
    const engine = this.ensureEngine(board);
    const workflow = createWorkflow(name, steps);
    this.currentRunIds.add(workflow.id);
    this.running = true;
    this.emit();
    engine.submitWorkflow(workflow).catch((error) => {
      this.running = false;
      this.emit();
      MessagePlugin.error(
        error instanceof Error ? error.message : '工作流提交失败'
      );
    });
  }

  /** 运行画布上的全部工作流 */
  runAll(): void {
    const board = this.board;
    if (!board) {
      MessagePlugin.warning('画布未就绪');
      return;
    }
    if (this.running) {
      MessagePlugin.warning('已有工作流在运行中');
      return;
    }
    const groups = collectWorkflowGraphs(board);
    if (groups.length === 0) {
      MessagePlugin.warning('画布上还没有工作流节点');
      return;
    }
    let total = 0;
    for (const group of groups) {
      try {
        const { steps } = compileGraph(group.graph);
        if (steps.length === 0) continue;
        total += steps.length;
        this.submitSteps(board, group.name, group.graph, steps);
      } catch (error) {
        if (error instanceof CompilerError) {
          MessagePlugin.error(error.message);
        } else {
          throw error;
        }
      }
    }
    if (total === 0) {
      MessagePlugin.warning('工作流中没有可执行的节点');
    }
  }

  /** 运行单个节点及其上游 */
  runNode(nodeId: string): void {
    const board = this.board;
    if (!board) {
      MessagePlugin.warning('画布未就绪');
      return;
    }
    if (this.running) {
      MessagePlugin.warning('已有工作流在运行中');
      return;
    }
    const groups = collectWorkflowGraphs(board);
    const group = groups.find((g) => g.graph.nodes.some((n) => n.id === nodeId));
    if (!group) {
      MessagePlugin.warning('未找到该节点所属的工作流');
      return;
    }
    try {
      const { steps } = compileGraph(group.graph);
      const upstream = getUpstreamNodeIds(group.graph, nodeId);
      const subset = steps.filter(
        (step) => step.id === nodeId || upstream.has(step.id)
      );
      if (subset.length === 0) {
        MessagePlugin.warning('该节点没有可执行内容');
        return;
      }
      for (const step of subset) {
        this.setStatus(step.id, 'pending');
      }
      this.submitSteps(board, `节点 ${nodeId.slice(0, 8)}`, group.graph, subset);
    } catch (error) {
      if (error instanceof CompilerError) {
        MessagePlugin.error(error.message);
      } else {
        throw error;
      }
    }
  }

  stop(): void {
    if (!this.engine) return;
    for (const workflowId of this.currentRunIds) {
      this.engine.cancelWorkflow(workflowId);
    }
    this.running = false;
    this.emit();
  }
}

export const workflowRunService = new WorkflowRunService();

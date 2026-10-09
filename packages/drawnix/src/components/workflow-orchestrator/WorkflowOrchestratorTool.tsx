/**
 * 工作流编排工具(工具箱 WinBox 窗体内容)
 *
 * React Flow 画布 + 参数编辑 + 运行控制:
 * - 搭图:拖拽节点需后续加面板(M1 从工具条"添加节点"下拉添加,自动排布)
 * - 保存/打开:graph-storage 版本化存取
 * - 运行:compileGraph → WorkflowEngine.submitWorkflow;事件按 stepId(=nodeId)
 *   回填节点运行态;preview 节点完成后从上游步骤结果取图展示
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MessagePlugin } from '../../utils/message-plugin';
import { WorkflowEngine } from '../../services/workflow-engine/engine';
import { createWorkflow } from '../../services/workflow-engine/workflow-factory';
import type { WorkflowEvent } from '../../services/workflow-engine/types';
import { swCapabilitiesHandler } from '../../services/sw-capabilities';
import type { DelegatedOperation } from '../../services/sw-capabilities';
import {
  compileGraph,
  CompilerError,
  NODE_TYPE_SPECS,
} from '../../services/workflow-orchestrator/graph-compiler';
import {
  createEmptyGraph,
  type OrchestratorEdge,
  type OrchestratorGraph,
  type OrchestratorNode,
  type OrchestratorNodeTypeName,
} from '../../services/workflow-orchestrator/graph-schema';
import {
  deleteOrchestratorGraph,
  listOrchestratorGraphs,
  loadOrchestratorGraph,
  saveOrchestratorGraph,
} from '../../services/workflow-orchestrator/graph-storage';
import { orchestratorNodeTypes, type OrchestratorFlowNode } from './nodes';
import './workflow-orchestrator.scss';

/** 可添加的节点菜单(M1) */
const ADDABLE_NODES: Array<{ type: OrchestratorNodeTypeName; label: string }> = [
  { type: 'prompt', label: '提示词' },
  { type: 'reference-image', label: '参考图' },
  { type: 'model-picker', label: '模型与参数' },
  { type: 'image-generation', label: '文生图' },
  { type: 'image-variation', label: '基于图生成' },
  { type: 'insert-canvas', label: '插入画布' },
  { type: 'save-library', label: '存素材库' },
  { type: 'preview', label: '预览' },
];

interface RunState {
  workflowId: string | null;
  running: boolean;
}

export const WorkflowOrchestratorTool: React.FC = () => {
  const [graphName, setGraphName] = useState('未命名工作流');
  const [graphId, setGraphId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<OrchestratorFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeStatus, setNodeStatus] = useState<Record<string, string>>({});
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
  const [stepResults, setStepResults] = useState<Record<string, Record<string, unknown>>>({});
  const [running, setRunning] = useState(false);
  const [showList, setShowList] = useState(false);
  const [graphList, setGraphList] = useState<OrchestratorGraph[]>([]);
  const [showAddMenu, setShowAddMenu] = useState(false);

  const engineRef = useRef<WorkflowEngine | null>(null);
  const currentRunRef = useRef<{ workflowId: string } | null>(null);
  const statusTimers = useRef<number[]>([]);

  const ensureEngine = useCallback((): WorkflowEngine => {
    if (!engineRef.current) {
      engineRef.current = new WorkflowEngine({
        onEvent: (event: WorkflowEvent) => handleEngineEvent(event),
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
    return engineRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEngineEvent = useCallback((event: WorkflowEvent) => {
    const current = currentRunRef.current;
    if (!current || event.workflowId !== current.workflowId) return;
    const engine = engineRef.current;

    if (event.type === 'step') {
      const status = event.status ?? 'completed';
      setNodeStatus((prev) => ({ ...prev, [event.stepId]: status }));
      if (event.error) {
        setNodeErrors((prev) => ({ ...prev, [event.stepId]: event.error! }));
      }
      // 完成后从引擎取运行结果(preview/调试展示)
      if (status === 'completed' || status === 'failed') {
        const wf = engine?.getWorkflow(current.workflowId);
        const step = wf?.steps.find((s) => s.id === event.stepId);
        if (step?.result) {
          setStepResults((prev) => ({
            ...prev,
            [event.stepId]: step.result as Record<string, unknown>,
          }));
        }
      }
    } else if (event.type === 'completed') {
      setRunning(false);
      setNodeStatus((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (next[key] === 'pending' || next[key] === 'running') next[key] = 'completed';
        }
        return next;
      });
      MessagePlugin.success('工作流执行完成');
    } else if (event.type === 'failed') {
      setRunning(false);
      MessagePlugin.error(`工作流执行失败:${event.error}`);
    }
  }, []);

  /** React Flow 状态 → 持久化图 */
  const buildGraph = useCallback((): OrchestratorGraph => {
    const now = Date.now();
    const orchNodes: OrchestratorNode[] = nodes.map((n) => ({
      ...n.data.node,
      geometry: { x: n.position.x, y: n.position.y },
    }));
    const orchEdges: OrchestratorEdge[] = edges.map((e: Edge) => ({
      id: e.id,
      source: e.source,
      sourcePort: (e.sourceHandle ?? '') as string,
      target: e.target,
      targetPort: (e.targetHandle ?? '') as string,
    }));
    return {
      id: graphId ?? `wfg_${now}_${Math.random().toString(36).slice(2, 8)}`,
      name: graphName,
      schemaVersion: 1,
      nodes: orchNodes,
      edges: orchEdges,
      createdAt: now,
      updatedAt: now,
    };
  }, [nodes, edges, graphId, graphName]);

  /** 持久化图 → React Flow 状态 */
  const loadGraphIntoFlow = useCallback((graph: OrchestratorGraph) => {
    setGraphId(graph.id);
    setGraphName(graph.name);
    setNodes(
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'orchestrator' as const,
        position: n.geometry,
        data: { node: n, onParamChange: handleParamChange },
      }))
    );
    setEdges(
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourcePort,
        targetHandle: e.targetPort,
      }))
    );
    setNodeStatus({});
    setNodeErrors({});
    setStepResults({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNodes, setEdges]);

  const handleParamChange = useCallback(
    (nodeId: string, key: string, value: unknown) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  node: { ...n.data.node, params: { ...n.data.node.params, [key]: value } },
                },
              }
            : n
        )
      );
    },
    [setNodes]
  );

  const handleSave = useCallback(async () => {
    try {
      const graph = buildGraph();
      await saveOrchestratorGraph(graph);
      setGraphId(graph.id);
      MessagePlugin.success(`已保存「${graph.name}」`);
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : '保存失败');
    }
  }, [buildGraph]);

  const handleOpenList = useCallback(async () => {
    const list = await listOrchestratorGraphs();
    setGraphList(list);
    setShowList(true);
  }, []);

  const handleOpenGraph = useCallback(
    async (id: string) => {
      const graph = await loadOrchestratorGraph(id);
      if (!graph) {
        MessagePlugin.error('工作流不存在');
        return;
      }
      loadGraphIntoFlow(graph);
      setShowList(false);
    },
    [loadGraphIntoFlow]
  );

  const handleDeleteGraph = useCallback(
    async (id: string) => {
      await deleteOrchestratorGraph(id);
      setGraphList(await listOrchestratorGraphs());
      if (graphId === id) setGraphId(null);
    },
    [graphId]
  );

  const handleAddNode = useCallback(
    (type: OrchestratorNodeTypeName) => {
      setShowAddMenu(false);
      if (nodes.length >= 64) {
        MessagePlugin.warning('节点数已达上限(64)');
        return;
      }
      const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const newNode: OrchestratorNode = {
        id,
        type,
        params: {},
        geometry: {
          x: 80 + Math.random() * 320,
          y: 60 + Math.random() * 240,
        },
      };
      setNodes((prev) =>
        prev.concat({
          id,
          type: 'orchestrator' as const,
          position: newNode.geometry,
          data: { node: newNode, onParamChange: handleParamChange },
        })
      );
      setSelectedNodeId(id);
    },
    [nodes.length, setNodes, handleParamChange]
  );

  /** 连线校验:端口类型匹配才允许(实时反馈,编译期仍兜底) */
  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      const sourceNode = nodes.find((n) => n.id === conn.source);
      const targetNode = nodes.find((n) => n.id === conn.target);
      if (!sourceNode || !targetNode) return false;
      const sourceSpec = NODE_TYPE_SPECS[sourceNode.data.node.type];
      const targetSpec = NODE_TYPE_SPECS[targetNode.data.node.type];
      const sourcePort = [...sourceSpec.outputs, ...sourceSpec.inputs].find(
        (pt) => pt.id === conn.sourceHandle
      );
      const targetPort = [...targetSpec.inputs, ...targetSpec.outputs].find(
        (pt) => pt.id === conn.targetHandle
      );
      if (!sourcePort || !targetPort) {
        // eslint-disable-next-line no-console
        console.log('[wf-orch][isValid] reject: port not found', conn.sourceHandle, '->', conn.targetHandle);
        return false;
      }
      if (sourcePort.kind !== targetPort.kind) {
        if (!(sourcePort.kind === 'image' && targetPort.kind === 'image[]')) {
          // eslint-disable-next-line no-console
          console.log('[wf-orch][isValid] reject: kind', sourcePort.id, '->', targetPort.id);
          return false;
        }
      }
      // 禁止自环
      return conn.source !== conn.target;
    },
    [nodes]
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      // eslint-disable-next-line no-console
      console.log('[wf-orch][onConnect]', JSON.stringify(conn));
      if (!conn.sourceHandle || !conn.targetHandle) return;
      setEdges((prev) =>
        addEdge(
          {
            id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            source: conn.source,
            target: conn.target,
            sourceHandle: conn.sourceHandle,
            targetHandle: conn.targetHandle,
          },
          prev
        )
      );
    },
    [setEdges]
  );

  const handleRun = useCallback(async () => {
    if (running) return;
    const graph = buildGraph();
    let steps;
    try {
      const compiled = compileGraph(graph);
      steps = compiled.steps;
    } catch (error) {
      if (error instanceof CompilerError) {
        MessagePlugin.error(error.message);
        return;
      }
      throw error;
    }
    if (steps.length === 0) {
      MessagePlugin.warning('图中没有可执行的节点');
      return;
    }

    const statusInit: Record<string, string> = {};
    for (const step of steps) statusInit[step.id] = 'pending';
    setNodeStatus(statusInit);
    setNodeErrors({});
    setStepResults({});
    setRunning(true);

    const workflow = createWorkflow(graph.name, steps);
    currentRunRef.current = { workflowId: workflow.id };
    ensureEngine();
    try {
      await engineRef.current!.submitWorkflow(workflow);
    } catch (error) {
      setRunning(false);
      MessagePlugin.error(
        error instanceof Error ? error.message : '工作流提交失败'
      );
    }
  }, [buildGraph, running, ensureEngine]);

  const handleStop = useCallback(() => {
    const current = currentRunRef.current;
    if (current) {
      engineRef.current?.cancelWorkflow(current.workflowId);
      setRunning(false);
    }
  }, []);

  const handleClear = useCallback(() => {
    if (running) return;
    setNodes([]);
    setEdges([]);
    setGraphId(null);
    setGraphName('未命名工作流');
    setNodeStatus({});
    setNodeErrors({});
    setStepResults({});
  }, [running, setNodes, setEdges]);

  /** 选中节点(参数面板) */
  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  /** preview 节点:取上游步骤结果图片 */
  const previewUrlsFor = useCallback(
    (nodeId: string): string[] => {
      const upstreamEdge = edges.find((e) => e.target === nodeId);
      if (!upstreamEdge) return [];
      const result = stepResults[upstreamEdge.source];
      const urls = (result?.urls as string[]) || [];
      return urls;
    },
    [edges, stepResults]
  );

  // 把运行态/结果合入节点 data(供节点组件渲染)
  const decoratedNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          status: nodeStatus[n.id],
          error: nodeErrors[n.id],
          resultUrls:
            n.data.node.type === 'preview' ? previewUrlsFor(n.id) : undefined,
        },
      })) as OrchestratorFlowNode[],
    [nodes, nodeStatus, nodeErrors, previewUrlsFor]
  );

  return (
    <div className="wf-orch-tool" data-testid="workflow-orchestrator">
      <div className="wf-orch-toolbar">
        <input
          className="wf-orch-toolbar__name"
          value={graphName}
          onChange={(e) => setGraphName(e.target.value)}
          placeholder="工作流名称"
        />
        <div className="wf-orch-toolbar__group">
          <button type="button" className="wf-orch-btn" onClick={handleSave} disabled={running}>
            保存
          </button>
          <button type="button" className="wf-orch-btn" onClick={handleOpenList}>
            打开
          </button>
          <button type="button" className="wf-orch-btn" onClick={handleClear} disabled={running}>
            清空
          </button>
        </div>
        <div className="wf-orch-toolbar__group">
          <div className="wf-orch-addwrap">
            <button
              type="button"
              className="wf-orch-btn"
              onClick={() => setShowAddMenu((v) => !v)}
              disabled={running}
            >
              添加节点 ▾
            </button>
            {showAddMenu && (
              <div className="wf-orch-addmenu">
                {ADDABLE_NODES.map((n) => (
                  <button
                    key={n.type}
                    type="button"
                    className="wf-orch-addmenu__item"
                    onClick={() => handleAddNode(n.type)}
                  >
                    {n.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {running ? (
            <button type="button" className="wf-orch-btn wf-orch-btn--stop" onClick={handleStop}>
              停止
            </button>
          ) : (
            <button
              type="button"
              className="wf-orch-btn wf-orch-btn--run"
              onClick={handleRun}
              data-testid="wf-orch-run"
            >
              运行
            </button>
          )}
        </div>
      </div>

      <div className="wf-orch-canvas">
        <ReactFlowProvider>
          <ReactFlow
            onConnectStart={(e, { nodeId, handleId }) =>
              // eslint-disable-next-line no-console
              console.log('[wf-orch][connectStart]', nodeId, handleId)
            }
            onConnectEnd={(e) =>
              // eslint-disable-next-line no-console
              console.log('[wf-orch][connectEnd]', String(e?.type))
            }
            nodes={decoratedNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={(changes) => {
              if (running) return;
              onEdgesChange(changes);
            }}
            onConnect={handleConnect}
            isValidConnection={isValidConnection}
            nodeTypes={orchestratorNodeTypes}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            minZoom={0.2}
            maxZoom={1.6}
          >
            <Background gap={18} />
            <Controls position="bottom-right" showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>

        {selectedNode && (
          <div className="wf-orch-inspector" data-testid="wf-orch-inspector">
            <div className="wf-orch-inspector__title">
              节点设置 · {selectedNode.data.node.id.slice(0, 10)}
            </div>
            {Object.entries(selectedNode.data.node.params).length === 0 && (
              <div className="wf-orch-inspector__empty">该节点暂无参数,可直接连线运行</div>
            )}
            {Object.entries(selectedNode.data.node.params).map(([key, value]) => (
              <div key={key} className="wf-orch-inspector__field">
                <label>{key}</label>
                <input
                  value={String(value ?? '')}
                  onChange={(e) =>
                    handleParamChange(selectedNode.id, key, e.target.value)
                  }
                />
              </div>
            ))}
          </div>
        )}

        {showList && (
          <div className="wf-orch-list" data-testid="wf-orch-list">
            <div className="wf-orch-list__title">我的工作流({graphList.length})</div>
            {graphList.length === 0 && (
              <div className="wf-orch-list__empty">还没有保存过工作流</div>
            )}
            {graphList.map((g) => (
              <div key={g.id} className="wf-orch-list__item">
                <button
                  type="button"
                  className="wf-orch-list__name"
                  onClick={() => handleOpenGraph(g.id)}
                >
                  {g.name}
                  <span className="wf-orch-list__meta">
                    {g.nodes.length} 节点 · {new Date(g.updatedAt).toLocaleString()}
                  </span>
                </button>
                <button
                  type="button"
                  className="wf-orch-list__del"
                  onClick={() => handleDeleteGraph(g.id)}
                >
                  删除
                </button>
              </div>
            ))}
            <button
              type="button"
              className="wf-orch-btn wf-orch-list__close"
              onClick={() => setShowList(false)}
            >
              关闭
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkflowOrchestratorTool;

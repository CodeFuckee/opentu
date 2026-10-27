/**
 * Flowgram 工作流编排编辑器(/workflow 全屏视图入口)。
 *
 * 数据层共用既有编排底座:graph-storage 存取、graph-compiler 校验、
 * workflow-run-service 执行;本组件只做 Flowgram 编辑器壳与图管理。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  EditorRenderer,
  FreeLayoutEditorProvider,
  useClientContext,
  type FreeLayoutProps,
} from '@flowgram.ai/free-layout-editor';
import { createFreeLinesPlugin } from '@flowgram.ai/free-lines-plugin';
import { createFreeStackPlugin } from '@flowgram.ai/free-stack-plugin';
import { createMinimapPlugin } from '@flowgram.ai/minimap-plugin';

import '@flowgram.ai/free-layout-editor/index.css';
import './flowgram-editor.scss';

import { MessagePlugin } from '../../utils/message-plugin';
import {
  createEmptyGraph,
  type OrchestratorGraph,
} from '../../services/workflow-orchestrator/graph-schema';
import {
  deleteOrchestratorGraph,
  listOrchestratorGraphs,
  loadOrchestratorGraph,
  saveOrchestratorGraph,
} from '../../services/workflow-orchestrator/graph-storage';
import {
  fromFlowgramDocument,
  toFlowgramDocument,
  type FlowgramDocumentJSON,
} from '../../services/workflow-orchestrator/flowgram-adapter';
import { workflowRunService } from '../../services/workflow-orchestrator/workflow-run-service';
import { crashRecoveryService } from '../../services/crash-recovery-service';
import { getPortKind, isPortKindCompatible } from './constants';
import { nodeRegistries, getNodeDefaultRegistry } from './node-registries';
import { WorkflowNodeCard } from './node-card';
import { NodePanel } from './node-panel';
import { Sidebar } from './sidebar';
import { HoverTip } from '../shared/hover';

/** 空实现占位(桥接清理/初始值,避免 no-empty-function) */
const noop = () => undefined;

/** 极简防抖(不引 lodash) */
function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

interface GraphMeta {
  id: string;
  name: string;
  createdAt: number;
}

interface GraphListItem extends GraphMeta {
  updatedAt: number;
  nodeCount: number;
}

function readGraphIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('graph');
}

function syncGraphIdToUrl(graphId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('graph', graphId);
  window.history.replaceState(null, '', url.toString());
}

/** 顶部工具栏(返回/图名/图列表/新建/保存/运行) */
const Topbar: React.FC<{
  meta: GraphMeta;
  graphList: GraphListItem[];
  listOpen: boolean;
  saving: boolean;
  onNameChange: (name: string) => void;
  onSave: () => void;
  onToggleList: () => void;
  onOpenGraph: (id: string) => void;
  onDeleteGraph: (id: string) => void;
  onNewGraph: () => void;
  onRun: () => void;
  onStop: () => void;
}> = ({
  meta,
  graphList,
  listOpen,
  saving,
  onNameChange,
  onSave,
  onToggleList,
  onOpenGraph,
  onDeleteGraph,
  onNewGraph,
  onRun,
  onStop,
}) => {
  const snapshot = useSyncExternalStore(
    workflowRunService.subscribe,
    workflowRunService.getSnapshot
  );
  const running = snapshot.running;
  const failedCount = Object.values(snapshot.statuses).filter((s) => s === 'failed').length;

  return (
    <header className="fwf-topbar">
      <HoverTip content="返回主画布" placement="bottom">
        <button
          type="button"
          className="fwf-topbar__btn"
          onClick={() => {
            window.location.href = '/';
          }}
        >
          ← 画布
        </button>
      </HoverTip>
      <input
        className="fwf-topbar__name"
        value={meta.name}
        placeholder="工作流名称"
        onChange={(e) => onNameChange(e.target.value)}
      />
      <button type="button" className="fwf-topbar__btn" onClick={onToggleList}>
        我的图({graphList.length})
      </button>
      <button type="button" className="fwf-topbar__btn" onClick={onNewGraph}>
        新建
      </button>
      <button
        type="button"
        className="fwf-topbar__btn fwf-topbar__btn--primary"
        onClick={onSave}
        disabled={saving}
      >
        {saving ? '保存中…' : '保存'}
      </button>
      <div className="fwf-topbar__spacer" />
      {running ? (
        <button
          type="button"
          className="fwf-topbar__btn fwf-topbar__btn--danger"
          onClick={onStop}
        >
          停止
        </button>
      ) : (
        <button
          type="button"
          className="fwf-topbar__btn fwf-topbar__btn--primary"
          onClick={onRun}
        >
          ▶ 运行
        </button>
      )}
      {failedCount > 0 ? (
        <span className="fwf-topbar__failed">{failedCount} 个节点失败</span>
      ) : null}
      {listOpen ? (
        <div className="fwf-graph-list">
          <div className="fwf-graph-list__title">我的工作流</div>
          {graphList.length === 0 ? (
            <div className="fwf-graph-list__empty">还没有保存过工作流</div>
          ) : (
            graphList.map((item) => (
              <div
                key={item.id}
                className={`fwf-graph-list__item${
                  item.id === meta.id ? ' fwf-graph-list__item--current' : ''
                }`}
              >
                <HoverTip content={item.name} placement="top">
                  <button
                    type="button"
                    className="fwf-graph-list__open"
                    onClick={() => onOpenGraph(item.id)}
                  >
                    <span className="fwf-graph-list__name">{item.name}</span>
                    <span className="fwf-graph-list__meta">
                      {item.nodeCount} 节点 · {new Date(item.updatedAt).toLocaleString()}
                    </span>
                  </button>
                </HoverTip>
                <HoverTip content="删除" placement="top">
                  <button
                    type="button"
                    className="fwf-graph-list__delete"
                    onClick={() => onDeleteGraph(item.id)}
                  >
                    删
                  </button>
                </HoverTip>
              </div>
            ))
          )}
        </div>
      ) : null}
    </header>
  );
};

interface ShellProps {
  meta: GraphMeta;
  graphList: GraphListItem[];
  /** onContentChange → 自动保存 的桥(EditorShell 挂载后写入) */
  contentChangeBridge: MutableRef<{ fn: () => void }>;
  onMetaChange: (next: GraphMeta) => void;
  onNewGraph: () => void;
  refreshList: () => void;
}

interface MutableRef<T> {
  current: T;
}

/** 编辑器主体(挂在 FreeLayoutEditorProvider 内,可用 useClientContext) */
const EditorShell: React.FC<ShellProps> = ({
  meta,
  graphList,
  contentChangeBridge,
  onMetaChange,
  onNewGraph,
  refreshList,
}) => {
  const ctx = useClientContext();
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const [saving, setSaving] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  // 编辑器壳已挂载 = 本视图加载成功;否则下次回主画布时 markLoadingStart
  // 会把遗留的 'loading' 误判为连续崩溃(弹「页面异常退出」恢复窗)
  useEffect(() => {
    crashRecoveryService.markLoadingComplete();
  }, []);

  /** 收集编辑器文档 → OrchestratorGraph → 落盘;成功返回图 */
  const collectAndSave = useCallback(
    async (silent: boolean): Promise<OrchestratorGraph | null> => {
      const current = metaRef.current;
      const doc = ctx.document.toJSON() as FlowgramDocumentJSON;
      const graph = fromFlowgramDocument(doc, {
        id: current.id,
        name: current.name,
        createdAt: current.createdAt,
      });
      try {
        await saveOrchestratorGraph(graph);
        if (!silent) {
          MessagePlugin.success('已保存');
        }
        refreshList();
        return graph;
      } catch (error) {
        MessagePlugin.error(
          error instanceof Error ? `保存失败:${error.message}` : '保存失败'
        );
        return null;
      }
    },
    [ctx, refreshList]
  );

  const autoSave = useMemo(
    () => debounce(() => void collectAndSave(true), 800),
    [collectAndSave]
  );

  // 桥接:editorProps.onContentChange(App 层构建)调到这里做防抖自动保存
  useEffect(() => {
    contentChangeBridge.current.fn = () => autoSave();
    return () => {
      autoSave.cancel();
      contentChangeBridge.current.fn = noop;
    };
  }, [autoSave, contentChangeBridge]);

  const handleSave = useCallback(() => {
    setSaving(true);
    void collectAndSave(false).finally(() => setSaving(false));
  }, [collectAndSave]);

  const handleRun = useCallback(async () => {
    const graph = await collectAndSave(true);
    if (!graph) return;
    if (graph.nodes.length === 0) {
      MessagePlugin.warning('空工作流:先添加节点');
      return;
    }
    workflowRunService.runGraph(graph);
  }, [collectAndSave]);

  const openGraph = useCallback(
    (id: string) => {
      void loadOrchestratorGraph(id).then((graph) => {
        if (!graph) {
          MessagePlugin.error('图不存在');
          return;
        }
        ctx.document.fromJSON(toFlowgramDocument(graph) as never);
        onMetaChange({ id: graph.id, name: graph.name, createdAt: graph.createdAt });
        syncGraphIdToUrl(graph.id);
        setListOpen(false);
      });
    },
    [ctx, onMetaChange]
  );

  const deleteGraph = useCallback(
    (id: string) => {
      void deleteOrchestratorGraph(id).then(() => {
        MessagePlugin.success('已删除');
        refreshList();
        if (id === metaRef.current.id) {
          onNewGraph();
        }
      });
    },
    [onNewGraph, refreshList]
  );

  return (
    <div className="fwf-layout">
      <Topbar
        meta={meta}
        graphList={graphList}
        listOpen={listOpen}
        saving={saving}
        onNameChange={(name) => onMetaChange({ ...meta, name })}
        onSave={handleSave}
        onToggleList={() => setListOpen((v) => !v)}
        onOpenGraph={openGraph}
        onDeleteGraph={deleteGraph}
        onNewGraph={onNewGraph}
        onRun={() => void handleRun()}
        onStop={() => workflowRunService.stop()}
      />
      <div className="fwf-main">
        <NodePanel />
        <div className="fwf-canvas">
          <EditorRenderer className="fwf-editor" />
        </div>
        <Sidebar />
      </div>
    </div>
  );
};

/** /workflow 全屏应用:按 URL 加载图 → 渲染编辑器 */
export const WorkflowEditorApp: React.FC = () => {
  const [meta, setMeta] = useState<GraphMeta | null>(null);
  const [initialData, setInitialData] = useState<FlowgramDocumentJSON | null>(null);
  const [graphList, setGraphList] = useState<GraphListItem[]>([]);
  const contentChangeBridge = useRef<{ fn: () => void }>({ fn: noop });

  const refreshList = useCallback(() => {
    void listOrchestratorGraphs().then((graphs) =>
      setGraphList(
        graphs.map((g) => ({
          id: g.id,
          name: g.name,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
          nodeCount: g.nodes.length,
        }))
      )
    );
  }, []);

  const startEmptyGraph = useCallback(() => {
    const graph = createEmptyGraph();
    setMeta({ id: graph.id, name: graph.name, createdAt: graph.createdAt });
    setInitialData({ nodes: [], edges: [] });
    syncGraphIdToUrl(graph.id);
  }, []);

  useEffect(() => {
    refreshList();
    const fromUrl = readGraphIdFromUrl();
    if (!fromUrl) {
      startEmptyGraph();
      return;
    }
    void loadOrchestratorGraph(fromUrl).then((graph) => {
      if (graph) {
        setMeta({ id: graph.id, name: graph.name, createdAt: graph.createdAt });
        setInitialData(toFlowgramDocument(graph));
      } else {
        startEmptyGraph();
      }
    });
  }, [refreshList, startEmptyGraph]);

  const editorProps = useMemo<FreeLayoutProps>(
    () => ({
      background: true,
      readonly: false,
      initialData: (initialData ?? { nodes: [], edges: [] }) as never,
      nodeRegistries,
      getNodeDefaultRegistry(type) {
        return getNodeDefaultRegistry(type);
      },
      materials: {
        components: {},
        renderDefaultNode: WorkflowNodeCard,
      },
      nodeEngine: { enable: true },
      history: { enable: true, enableChangeNode: true },
      twoWayConnection: false,
      // 连线配色对齐 Md3(默认靛蓝 #4d53e8 与应用主色不符)
      lineColor: {
        hidden: 'transparent',
        default: 'var(--md3-primary, #0B57D0)',
        drawing: 'var(--md3-tertiary, #7D5260)',
        hovered: 'var(--md3-primary, #0B57D0)',
        selected: 'var(--md3-primary, #0B57D0)',
        error: 'var(--md3-error, #B3261E)',
        flowing: 'var(--md3-primary, #0B57D0)',
      },
      canAddLine(_ctx, fromPort, toPort) {
        // 禁自环
        if (fromPort.node === toPort.node) return false;
        // 禁成环(连到上游节点)
        if (fromPort.node.lines.allInputNodes.includes(toPort.node)) return false;
        // 端口类型校验(与编译器 isKindCompatible 同规则)
        const fromKind = getPortKind(
          String(fromPort.node.flowNodeType),
          String(fromPort.portID ?? '')
        );
        const toKind = getPortKind(
          String(toPort.node.flowNodeType),
          String(toPort.portID ?? '')
        );
        if (!fromKind || !toKind) return false;
        return isPortKindCompatible(fromKind, toKind);
      },
      onContentChange: () => {
        contentChangeBridge.current.fn();
      },
      onAllLayersRendered: (ctx) => {
        ctx.tools.fitView(false);
      },
      i18n: {
        locale: 'zh-CN',
        languages: { 'zh-CN': {}, 'en-US': {} },
      },
      plugins: () => [
        createFreeLinesPlugin({}),
        createFreeStackPlugin({}),
        createMinimapPlugin({
          disableLayer: true,
          canvasStyle: {
            canvasWidth: 168,
            canvasHeight: 96,
            canvasPadding: 40,
            canvasBackground: 'rgba(120, 120, 120, 0.12)',
            canvasBorderRadius: 8,
            viewportBackground: 'rgba(120, 120, 120, 0.22)',
            viewportBorderRadius: 4,
            nodeColor: 'rgba(120, 120, 120, 0.45)',
            nodeBorderRadius: 2,
          },
        }),
      ],
    }),
    // 编辑器实例随图切换重建(Provider key 同步变化);initialData 仅构建期读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta?.id]
  );

  if (!meta || !initialData) {
    return <div className="fwf-root fwf-root--loading">正在加载工作流编辑器…</div>;
  }

  return (
    <div className="fwf-root">
      <FreeLayoutEditorProvider key={meta.id} {...editorProps}>
        <EditorShell
          meta={meta}
          graphList={graphList}
          contentChangeBridge={contentChangeBridge}
          onMetaChange={setMeta}
          onNewGraph={() => {
            startEmptyGraph();
          }}
          refreshList={refreshList}
        />
      </FreeLayoutEditorProvider>
    </div>
  );
};

export default WorkflowEditorApp;

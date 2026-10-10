/**
 * 工作流编排面板(工具箱 WinBox 内容)
 *
 * 节点画布在主画布上:本面板是控制台——添加节点到画布、运行全部/停止、
 * 导入 M1 旧版编排图(IndexedDB → 画布元素)。
 */
import React, { useCallback, useState } from 'react';
import { MessagePlugin } from '../../utils/message-plugin';
import {
  deleteOrchestratorGraph,
  listOrchestratorGraphs,
  loadOrchestratorGraph,
} from '../../services/workflow-orchestrator/graph-storage';
import { workflowRunService } from '../../services/workflow-orchestrator/workflow-run-service';
import type {
  OrchestratorGraph,
  OrchestratorNodeTypeName,
} from '../../services/workflow-orchestrator/graph-schema';
import './workflow-orchestrator-palette.scss';

const ADDABLE: Array<{ type: OrchestratorNodeTypeName; label: string }> = [
  { type: 'prompt', label: '提示词' },
  { type: 'reference-image', label: '参考图' },
  { type: 'model-picker', label: '模型与参数' },
  { type: 'image-generation', label: '文生图' },
  { type: 'image-variation', label: '基于图生成' },
  { type: 'insert-canvas', label: '插入画布' },
  { type: 'save-library', label: '存素材库' },
  { type: 'preview', label: '预览' },
];

export const WorkflowOrchestratorPalette: React.FC = () => {
  const [running, setRunning] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importList, setImportList] = useState<OrchestratorGraph[]>([]);

  const runService = workflowRunService;

  // 运行态同步(停止按钮)
  React.useEffect(() => {
    return runService.subscribe(() => setRunning(runService.getSnapshot().running));
  }, [runService]);

  const handleAdd = useCallback(
    (type: OrchestratorNodeTypeName) => {
      const created = runService.insertNode(type);
      if (created) {
        MessagePlugin.success(
          `已添加「${ADDABLE.find((a) => a.type === type)?.label}」节点,拖到合适位置并双击编辑`
        );
      }
    },
    [runService]
  );

  const handleRunAll = useCallback(() => {
    runService.runAll();
  }, [runService]);

  const handleStop = useCallback(() => {
    runService.stop();
  }, [runService]);

  const handleOpenImport = useCallback(async () => {
    const list = await listOrchestratorGraphs();
    setImportList(list);
    setShowImport(true);
  }, []);

  const handleImport = useCallback(
    async (graphId: string) => {
      const graph = await loadOrchestratorGraph(graphId);
      if (!graph) {
        MessagePlugin.error('旧图不存在');
        return;
      }
      const ok = runService.importLegacyGraph(graph);
      if (ok) {
        setImportList((prev) => prev.filter((g) => g.id !== graphId));
      }
    },
    [runService]
  );

  return (
    <div className="wf-orch-palette" data-testid="workflow-orchestrator">
      <div className="wf-orch-palette__section">
        <div className="wf-orch-palette__section-title">添加节点(落点后可拖动,双击编辑)</div>
        <div className="wf-orch-palette__grid">
          {ADDABLE.map((n) => (
            <button
              key={n.type}
              type="button"
              className="wf-orch-palette__add"
              onClick={() => handleAdd(n.type)}
            >
              {n.label}
            </button>
          ))}
        </div>
      </div>

      <div className="wf-orch-palette__section">
        <div className="wf-orch-palette__section-title">运行(按连通图划分)</div>
        <div className="wf-orch-palette__row">
          {running ? (
            <button
              type="button"
              className="wf-orch-palette__btn wf-orch-palette__btn--stop"
              onClick={handleStop}
              data-testid="wf-run-stop"
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              className="wf-orch-palette__btn wf-orch-palette__btn--run"
              onClick={handleRunAll}
              data-testid="wf-run-all"
            >
              运行全部
            </button>
          )}
        </div>
        <div className="wf-orch-palette__hint">
          连在一起的一簇节点 = 一个工作流;节点 ▶ 只跑该节点及上游
        </div>
      </div>

      <div className="wf-orch-palette__section">
        <div className="wf-orch-palette__section-title">M1 旧图导入</div>
        <button
          type="button"
          className="wf-orch-palette__btn"
          onClick={handleOpenImport}
        >
          打开旧版编排图列表
        </button>
        {showImport && (
          <div className="wf-orch-palette__imports">
            {importList.length === 0 && (
              <div className="wf-orch-palette__hint">没有可导入的旧图</div>
            )}
            {importList.map((g) => (
              <div key={g.id} className="wf-orch-palette__import-item">
                <button
                  type="button"
                  className="wf-orch-palette__import-name"
                  onClick={() => handleImport(g.id)}
                >
                  {g.name}({g.nodes.length} 节点)→ 导入到画布
                </button>
                <button
                  type="button"
                  className="wf-orch-palette__import-del"
                  onClick={async () => {
                    await deleteOrchestratorGraph(g.id);
                    setImportList((prev) => prev.filter((x) => x.id !== g.id));
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkflowOrchestratorPalette;

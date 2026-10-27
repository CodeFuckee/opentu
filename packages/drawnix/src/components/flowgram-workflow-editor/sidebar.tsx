/**
 * 右侧参数面板:渲染选中节点的表单(同一 formMeta 的侧栏布局)。
 *
 * 挂载模式对齐官方 demo SidebarNodeRenderer:IsSidebarContext 置真 +
 * PlaygroundEntityContext 指向选中节点 + useNodeRender(node) 驱动表单。
 */
import React, { useEffect, useState } from 'react';
import {
  PlaygroundEntityContext,
  useClientContext,
  useNodeRender,
  type FlowNodeEntity,
} from '@flowgram.ai/free-layout-editor';

import type { OrchestratorNodeTypeName } from '../../services/workflow-orchestrator/graph-schema';
import { NODE_TYPE_LABELS } from './constants';
import { IsSidebarContext } from './node-forms';

const SidebarNodeRenderer: React.FC<{ node: FlowNodeEntity }> = ({ node }) => {
  const nodeRender = useNodeRender(node);
  const nodeType = node.flowNodeType as OrchestratorNodeTypeName;
  return (
    <div className="fwf-sidebar__card">
      <div className="fwf-sidebar__title">{NODE_TYPE_LABELS[nodeType] ?? nodeType}</div>
      <div className="fwf-sidebar__body">{nodeRender.form?.render()}</div>
    </div>
  );
};

export const Sidebar: React.FC = () => {
  const ctx = useClientContext();
  const [selectedNode, setSelectedNode] = useState<FlowNodeEntity | null>(null);

  useEffect(() => {
    const syncSelection = () => {
      const selection = ctx.selection.selection;
      const node =
        selection.length === 1 && 'flowNodeType' in (selection[0] as object)
          ? (selection[0] as FlowNodeEntity)
          : null;
      setSelectedNode(node);
    };
    syncSelection();
    const disposable = ctx.selection.onSelectionChanged(syncSelection);
    return () => disposable.dispose();
  }, [ctx]);

  if (!selectedNode) {
    return (
      <aside className="fwf-sidebar">
        <div className="fwf-sidebar__empty">选中节点后在此编辑参数</div>
      </aside>
    );
  }

  return (
    <aside className="fwf-sidebar">
      <IsSidebarContext.Provider value={true}>
        <PlaygroundEntityContext.Provider key={selectedNode.id} value={selectedNode as never}>
          <SidebarNodeRenderer node={selectedNode} />
        </PlaygroundEntityContext.Provider>
      </IsSidebarContext.Provider>
    </aside>
  );
};

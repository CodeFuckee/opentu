/**
 * 默认节点渲染器(materials.renderDefaultNode):
 * 节点卡片壳(拖拽/选中/状态徽标) + 表单内容 + 端口渲染。
 *
 * 结构对齐官方 demo 的 BaseNode + NodeWrapper:表单由 formMeta 渲染,
 * 端口由 WorkflowPortRender 自定位,卡片只负责壳与交互。
 */
import React from 'react';
import {
  useNodeRender,
  WorkflowPortRender,
  type WorkflowNodeEntity,
} from '@flowgram.ai/free-layout-editor';
import { useSyncExternalStore } from 'react';

import { workflowRunService } from '../../services/workflow-orchestrator/workflow-run-service';
import type { OrchestratorNodeTypeName } from '../../services/workflow-orchestrator/graph-schema';
import { HoverTip } from '../shared/hover';
import {
  NODE_TYPE_CATEGORIES,
  NODE_TYPE_ICONS,
  NODE_TYPE_LABELS,
  NODE_TYPE_SIZES,
} from './constants';

const STATUS_LABELS: Record<string, string> = {
  pending: '等待',
  running: '运行中',
  completed: '完成',
  failed: '失败',
};

const RunStatusBadge: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const snapshot = useSyncExternalStore(
    workflowRunService.subscribe,
    workflowRunService.getSnapshot
  );
  const status = snapshot.statuses[nodeId];
  if (!status) return null;
  const hint = snapshot.errors[nodeId] ?? STATUS_LABELS[status] ?? status;
  return (
    <HoverTip content={hint} placement="top">
      <span className={`fwf-node-status fwf-node-status--${status}`}>
        {STATUS_LABELS[status] ?? status}
      </span>
    </HoverTip>
  );
};

export const WorkflowNodeCard: React.FC<{ node: WorkflowNodeEntity }> = ({ node }) => {
  const nodeRender = useNodeRender();
  const {
    selected,
    startDrag,
    ports,
    selectNode,
    nodeRef,
    onFocus,
    onBlur,
    form,
  } = nodeRender;
  const nodeType = node.flowNodeType as OrchestratorNodeTypeName;
  // 注册 meta.size 并不保证落到渲染容器(实测新加节点塌成内容宽度),卡片自带显式尺寸:
  // 实体 meta 优先,常量表兜底
  const metaSize = node.getNodeMeta<{ size?: { width: number; height: number } }>()?.size;
  const size = metaSize ?? NODE_TYPE_SIZES[nodeType] ?? { width: 260, height: 150 };

  const portsRender = ports.map((p) => <WorkflowPortRender key={p.id} entity={p} />);

  return (
    <>
      <div
        className={`fwf-node${selected ? ' fwf-node--selected' : ''}`}
        style={{ width: size.width, height: size.height }}
        ref={nodeRef}
        draggable
        onDragStart={(e) => startDrag(e)}
        onClick={(e) => selectNode(e)}
        onFocus={onFocus}
        onBlur={onBlur}
        data-node-id={node.id}
      >
        <div className={`fwf-node__header fwf-node__header--${NODE_TYPE_CATEGORIES[nodeType] ?? 'input'}`}>
          <span className="fwf-node__type">
            {React.createElement(NODE_TYPE_ICONS[nodeType] ?? NODE_TYPE_ICONS.prompt, { size: 13 })}
            <span>{NODE_TYPE_LABELS[nodeType] ?? nodeType}</span>
          </span>
          <RunStatusBadge nodeId={node.id} />
        </div>
        <div className="fwf-node__body">{form?.render()}</div>
      </div>
      {portsRender}
    </>
  );
};

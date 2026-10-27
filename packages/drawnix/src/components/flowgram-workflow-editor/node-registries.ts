/**
 * Flowgram 节点注册:8 种编排节点(NODE_TYPE_SPECS 派生端口) + 表单。
 */
import type { WorkflowNodeRegistry } from '@flowgram.ai/free-layout-editor';

import type { OrchestratorNodeTypeName } from '../../services/workflow-orchestrator/graph-schema';
import {
  NODE_TYPE_LABELS,
  NODE_PANEL_ORDER,
  NODE_TYPE_SIZES,
  getPortsOfType,
} from './constants';
import { createFormMeta, fallbackFormMeta } from './node-forms';

function createNodeRegistry(type: OrchestratorNodeTypeName): WorkflowNodeRegistry {
  return {
    type,
    meta: {
      defaultExpanded: true,
      defaultPorts: getPortsOfType(type) as never,
      size: NODE_TYPE_SIZES[type],
    },
    info: {
      icon: '',
      description: NODE_TYPE_LABELS[type],
    },
    formMeta: createFormMeta(type),
  };
}

export const nodeRegistries: WorkflowNodeRegistry[] = NODE_PANEL_ORDER.map(createNodeRegistry);

/** 未知类型的兜底注册(旧数据/未来类型进来可显示、不可编译) */
export function getNodeDefaultRegistry(type: string | number): WorkflowNodeRegistry {
  return {
    type,
    meta: { defaultExpanded: true },
    formMeta: fallbackFormMeta,
  };
}

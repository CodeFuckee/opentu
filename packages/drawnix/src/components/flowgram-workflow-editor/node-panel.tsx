/**
 * 左侧节点面板:点击添加节点(级联排布防堆叠,首个节点后自动取景)。
 */
import React, { useCallback, useRef } from 'react';
import {
  useClientContext,
  useService,
  WorkflowSelectService,
  type WorkflowDocument,
} from '@flowgram.ai/free-layout-editor';

import type { OrchestratorNodeTypeName } from '../../services/workflow-orchestrator/graph-schema';
import { HoverTip } from '../shared/hover';
import {
  NODE_PANEL_ORDER,
  NODE_TYPE_CATEGORIES,
  NODE_TYPE_ICONS,
  NODE_TYPE_LABELS,
} from './constants';

export const NodePanel: React.FC = () => {
  const ctx = useClientContext();
  const selectService = useService<WorkflowSelectService>(WorkflowSelectService);
  const addCountRef = useRef(0);
  const fitViewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addNode = useCallback(
    (type: OrchestratorNodeTypeName) => {
      // 网格排布:横 4 列(列距 340 > 卡宽 280,行距 240 > 卡高 170),绝不叠卡
      const n = addCountRef.current;
      addCountRef.current += 1;
      const position = {
        x: 160 + (n % 4) * 340,
        y: 140 + Math.floor(n / 4) * 240,
      };
      const node = ctx.document.createWorkflowNodeByType(type, position, { data: {} });
      if (node) {
        selectService.selectNode(node as never);
        // 加完取景:250ms 防抖,网格长出视口时自动收进来
        if (fitViewTimerRef.current) clearTimeout(fitViewTimerRef.current);
        fitViewTimerRef.current = setTimeout(() => {
          fitViewTimerRef.current = null;
          ctx.tools?.fitView?.(false);
        }, 250);
      }
    },
    [ctx, selectService]
  );

  return (
    <aside className="fwf-node-panel">
      <div className="fwf-node-panel__title">节点</div>
      <div className="fwf-node-panel__list">
        {NODE_PANEL_ORDER.map((type) => {
          const Icon = NODE_TYPE_ICONS[type];
          const category = NODE_TYPE_CATEGORIES[type];
          return (
            <HoverTip key={type} content={`添加「${NODE_TYPE_LABELS[type]}」节点`} placement="right">
              <button
                type="button"
                className="fwf-node-panel__item"
                onClick={() => addNode(type)}
              >
                <span className={`fwf-node-panel__dot fwf-node-panel__dot--${category}`}>
                  <Icon size={12} />
                </span>
                {NODE_TYPE_LABELS[type]}
              </button>
            </HoverTip>
          );
        })}
      </div>
      <div className="fwf-node-panel__hint">点击添加 · 拖端口连线 · Delete 删除</div>
    </aside>
  );
};

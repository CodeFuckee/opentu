/**
 * 工作流节点画布内容(React,渲染在 foreignObject 内)
 *
 * - 卡片:类型头 + 参数内联编辑 + 运行态条 + ▶ 单节点运行
 * - 右侧端口:按住拖到目标节点松开 → 生成数据流连线(屏幕空间临时线)
 * - 双击卡片:进入参数编辑浮层(编辑期间指针事件止步于浮层)
 */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PlaitBoard } from '@plait/core';
import type { PlaitWorkflowNode } from '../../types/workflow-node.types';
import { HoverTip } from '../shared/hover';
import { WorkflowNodeTransforms } from '../../data/workflow-node-transforms';
import { workflowRunService } from '../../services/workflow-orchestrator/workflow-run-service';

const TYPE_LABELS: Record<string, string> = {
  prompt: '提示词',
  'reference-image': '参考图',
  'model-picker': '模型与参数',
  'image-generation': '文生图',
  'image-variation': '基于图生成',
  'insert-canvas': '插入画布',
  'save-library': '存素材库',
  preview: '预览',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '等待',
  running: '运行中',
  completed: '完成',
  failed: '失败',
};

export interface WorkflowNodeContentProps {
  element: PlaitWorkflowNode;
  board: PlaitBoard;
  runService: typeof workflowRunService;
}

export const WorkflowNodeContent: React.FC<WorkflowNodeContentProps> = ({
  element,
  board,
  runService,
}) => {
  const snapshot = useSyncExternalStore(
    runService.subscribe,
    runService.getSnapshot
  );
  const status = snapshot.statuses[element.id];
  const error = snapshot.errors[element.id];
  const [editing, setEditing] = useState(false);

  // 连线拖拽:屏幕空间临时线;落点命中目标节点即建连线
  const dragRef = useRef<{
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);
  const [connectionDrag, setConnectionDrag] = useState<
    | {
        startX: number;
        startY: number;
        curX: number;
        curY: number;
      }
    | undefined
  >();

  const startConnection = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY,
      };
      setConnectionDrag({ ...dragRef.current });

      const onMove = (ev: PointerEvent) => {
        dragRef.current = {
          ...dragRef.current!,
          curX: ev.clientX,
          curY: ev.clientY,
        };
        setConnectionDrag({ ...dragRef.current });
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setConnectionDrag(undefined);
        dragRef.current = null;
        // 落点元素 → 目标节点卡片
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const card = el?.closest('.wf-node-card') as HTMLElement | null;
        const targetId = card?.dataset.nodeId;
        if (!targetId || targetId === element.id) return;
        const targetElement = (board.children as PlaitWorkflowNode[]).find(
          (n) => n.id === targetId
        );
        if (!targetElement) return;
        const sourcePort = 'outputs:default';
        const targetPort = 'inputs:default';
        WorkflowNodeTransforms.insertWorkflowConnection(
          board,
          element,
          targetElement,
          sourcePort,
          targetPort
        );
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [element, board]
  );

  const setParam = (key: string, value: unknown) => {
    WorkflowNodeTransforms.setParam(board, element, key, value);
  };

  const renderField = () => {
    switch (element.nodeType) {
      case 'prompt':
        return (
          <textarea
            className="wf-node-input"
            value={(element.params.text as string) ?? ''}
            placeholder="输入提示词…"
            rows={2}
            onChange={(e) => setParam('text', e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        );
      case 'reference-image':
        return (
          <input
            className="wf-node-input"
            value={(element.params.url as string) ?? ''}
            placeholder="图片 URL(或从素材库复制)"
            onChange={(e) => setParam('url', e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        );
      case 'model-picker':
        return (
          <div className="wf-node-row">
            <input
              className="wf-node-input"
              value={(element.params.model as string) ?? ''}
              placeholder="模型名"
              onChange={(e) => setParam('model', e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
            />
            <input
              className="wf-node-input wf-node-input--narrow"
              type="number"
              min={1}
              max={8}
              value={(element.params.count as number) ?? 1}
              onChange={(e) => setParam('count', Number(e.target.value) || 1)}
              onPointerDown={(e) => e.stopPropagation()}
            />
          </div>
        );
      case 'image-generation':
      case 'image-variation':
        return (
          <textarea
            className="wf-node-input"
            value={(element.params.prompt as string) ?? ''}
            placeholder="未连线时可在此填写提示词"
            rows={2}
            onChange={(e) => setParam('prompt', e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        );
      default:
        return <div className="wf-node-hint">连接左侧图片组端口</div>;
    }
  };

  return (
    <div
      className={`wf-node-card ${status ? `wf-node-card--${status}` : ''} ${
        editing ? 'wf-node-card--editing' : ''
      }`}
      data-node-id={element.id}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {/* 输出端口(右侧,拖出连线) */}
      <HoverTip content="拖到目标节点建立连线" showArrow={false}>
        <div
          className="wf-node-port wf-node-port--out"
          onPointerDown={startConnection}
        />
      </HoverTip>

      <div className="wf-node-card__header">
        <span className="wf-node-card__title">
          {TYPE_LABELS[element.nodeType] ?? element.nodeType}
        </span>
        <div className="wf-node-card__header-right">
          {status && (
            <span className={`wf-node-status wf-node-status--${status}`}>
              {STATUS_LABELS[status] ?? status}
            </span>
          )}
          <button
            type="button"
            className="wf-node-run-btn"
            aria-label="运行该节点及其上游"
            onClick={(e) => {
              e.stopPropagation();
              runService.runNode(element.id);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            ▶
          </button>
        </div>
      </div>

      <div className="wf-node-card__body">{renderField()}</div>

      {error && <div className="wf-node-card__error">{error}</div>}

      {editing && (
        <div className="wf-node-edit-panel" onPointerDown={(e) => e.stopPropagation()}>
          <div className="wf-node-edit-panel__title">节点参数</div>
          {Object.entries(element.params).map(([key, value]) => (
            <div key={key} className="wf-node-edit-panel__field">
              <label>{key}</label>
              <input
                value={String(value ?? '')}
                onChange={(e) => setParam(key, e.target.value)}
              />
            </div>
          ))}
          {Object.keys(element.params).length === 0 && (
            <div className="wf-node-edit-panel__empty">暂无参数</div>
          )}
          <button
            type="button"
            className="wf-node-edit-panel__done"
            onClick={() => setEditing(false)}
          >
            完成
          </button>
        </div>
      )}

      {connectionDrag && (
        <svg
          className="wf-node-connection-preview"
          style={{
            position: 'fixed',
            inset: 0,
            width: '100vw',
            height: '100vh',
            pointerEvents: 'none',
            zIndex: 10000,
          }}
        >
          <line
            x1={connectionDrag.startX}
            y1={connectionDrag.startY}
            x2={connectionDrag.curX}
            y2={connectionDrag.curY}
            stroke="#b45309"
            strokeWidth={2}
            strokeDasharray="6 4"
          />
          <circle
            cx={connectionDrag.curX}
            cy={connectionDrag.curY}
            r={5}
            fill="#b45309"
          />
        </svg>
      )}
    </div>
  );
};

export default WorkflowNodeContent;

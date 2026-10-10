/**
 * 工作流节点画布内容(React,渲染在 foreignObject 内)
 *
 * - 卡片:类型头 + 参数内联编辑 + 运行态条 + ▶ 单节点运行
 * - 右端口(橙):按住拖到目标工作流节点 → 生成图数据流
 * - 左端口(蓝):按住拖到画布图片元素 → 绑定该图片为参考输入
 * - 连线拖拽通过全屏遮罩层捕获指针事件(隔离 Plait 画布拦截)
 * - 双击卡片:进入参数编辑浮层
 */
import React, {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PlaitBoard, PlaitElement } from '@plait/core';
import type { PlaitWorkflowNode } from '../../types/workflow-node.types';
import { WorkflowNodeTransforms } from '../../data/workflow-node-transforms';
import { workflowRunService } from '../../services/workflow-orchestrator/workflow-run-service';
import { MessagePlugin } from '../../utils/message-plugin';

const TYPE_LABELS: Record<string, string> = {
  prompt: '提示词',
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
  const [connecting, setConnecting] = useState(false);
  const connectStartRef = useRef<{ x: number; y: number } | null>(null);
  const connectCurrentRef = useRef<{ x: number; y: number } | null>(null);
  const [connectPreview, setConnectPreview] = useState<{ sx: number; sy: number; cx: number; cy: number } | null>(null);

  const setParam = (key: string, value: unknown) => {
    WorkflowNodeTransforms.setParam(board, element, key, value);
  };

  // ---- 全屏遮罩连线拖拽(隔离 Plait 画布事件拦截) ----

  const startConnectionDrag = useCallback(
    (e: React.PointerEvent, direction: 'out' | 'in') => {
      e.stopPropagation();
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();

      const startX = e.clientX;
      const startY = e.clientY;
      connectStartRef.current = { x: startX, y: startY };

      // 创建全屏遮罩层:捕获后续所有指针事件,Plait 画布完全感知不到
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 99999;
        cursor: crosshair; background: transparent;
      `;
      document.body.appendChild(overlay);

      // 预览线 SVG(挂在遮罩内)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('stroke', '#b45309');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '6 4');
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '5');
      dot.setAttribute('fill', '#b45309');
      svg.append(line, dot);
      overlay.appendChild(svg);

      setConnecting(true);

      const onMove = (ev: PointerEvent) => {
        line.setAttribute('x1', String(startX));
        line.setAttribute('y1', String(startY));
        line.setAttribute('x2', String(ev.clientX));
        line.setAttribute('y2', String(ev.clientY));
        dot.setAttribute('cx', String(ev.clientX));
        dot.setAttribute('cy', String(ev.clientY));
        // 高亮命中的目标卡片
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const card = el?.closest('.wf-node-card') as HTMLElement | null;
        document.querySelectorAll('.wf-node-card').forEach((c) => {
          c.classList.toggle('wf-node-card--connect-target',
            c !== card && !!card && c.getAttribute('data-node-id') !== element.id);
        });
        if (card && card.getAttribute('data-node-id') !== element.id) {
          card.classList.add('wf-node-card--connect-target');
        }
      };

      const onUp = (ev: PointerEvent) => {
        overlay.remove();
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setConnecting(false);
        document.querySelectorAll('.wf-node-card--connect-target').forEach((c) =>
          c.classList.remove('wf-node-card--connect-target')
        );

        // 暂时禁用遮罩(已移除),用 elementFromPoint 精确命中
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!el) return;

        if (direction === 'out') {
          // 输出→目标工作流节点
          const card = el.closest('.wf-node-card') as HTMLElement | null;
          const targetId = card?.getAttribute('data-node-id');
          if (!targetId || targetId === element.id) return;
          const targetElement = (board.children as PlaitWorkflowNode[]).find(
            (n) => n.id === targetId
          );
          if (!targetElement) return;
          const targetPort =
            targetElement.nodeType === 'image-generation' || targetElement.nodeType === 'image-variation'
              ? 'inputs:referenceImages'
              : 'inputs:images';
          WorkflowNodeTransforms.insertWorkflowConnection(
            board, element, targetElement, 'outputs:images', targetPort
          );
          MessagePlugin.success('已连线');
        } else {
          // 输入→画布图片元素
          const img = el.closest('img') ?? el.querySelector('img');
          const src = img?.getAttribute('src') ?? '';
          if (!src) {
            MessagePlugin.warning('请拖到画布上的图片元素上');
            return;
          }
          const imageNode = (board.children as PlaitElement[]).find(
            (child) => (child as { url?: string }).url === src
          );
          if (!imageNode) return;
          WorkflowNodeTransforms.insertWorkflowConnection(
            board, imageNode as never, element, 'outputs:image', 'inputs:referenceImages'
          );
          MessagePlugin.success('已绑定参考图');
        }
      };

      overlay.addEventListener('pointermove', onMove);
      overlay.addEventListener('pointerup', onUp);
    },
    [element, board]
  );

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
          <div>
            <textarea
              className="wf-node-input"
              value={(element.params.prompt as string) ?? ''}
              placeholder="未连线时可在此填写提示词"
              rows={2}
              onChange={(e) => setParam('prompt', e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
            />
            {(element.params.referenceImages as string[])?.length ? (
              <div className="wf-node-ref-count">
                已绑定 {(element.params.referenceImages as string[]).length} 张参考图
              </div>
            ) : null}
          </div>
        );
      default:
        return <div className="wf-node-hint">连接左侧图片组端口</div>;
    }
  };

  const isGenerative =
    element.nodeType === 'image-generation' || element.nodeType === 'image-variation';

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
      {isGenerative && (
        <div
          style={{
            position: 'absolute', left: -7, top: '50%', transform: 'translateY(-50%)',
            width: 14, height: 14, borderRadius: '50%', cursor: 'crosshair', zIndex: 5,
            background: '#3b82f6', border: '2px solid #ffffff',
            boxShadow: '0 1px 4px rgba(15,23,42,0.25)',
          }}
          data-tip="拖到画布图片绑定参考输入"
          onPointerDown={(e) => startConnectionDrag(e, 'in')}
        />
      )}

      <div
        style={{
          position: 'absolute', right: -7, top: '50%', transform: 'translateY(-50%)',
          width: 14, height: 14, borderRadius: '50%', cursor: 'crosshair', zIndex: 5,
          background: '#b45309', border: '2px solid #ffffff',
          boxShadow: '0 1px 4px rgba(15,23,42,0.25)',
        }}
        data-tip="拖到目标节点建立连线"
        onPointerDown={(e) => startConnectionDrag(e, 'out')}
      />

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
    </div>
  );
};

export default WorkflowNodeContent;

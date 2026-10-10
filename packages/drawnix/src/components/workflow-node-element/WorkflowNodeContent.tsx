/**
 * 工作流节点画布内容(React,渲染在 foreignObject 内)
 *
 * - 卡片:类型头 + 参数内联编辑 + 运行态条 + ▶ 单节点运行
 * - 右端口(橙):按住拖到目标工作流节点 → 生成图数据流
 * - 左端口(蓝):按住拖到画布图片元素 → 绑定该图片为参考输入
 * - 连线预览用 board 坐标(与画布同空间,无偏移)
 * - 双击卡片:进入参数编辑浮层
 */
import React, {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { PlaitBoard, PlaitElement } from '@plait/core';
import type { PlaitWorkflowNode } from '../../types/workflow-node.types';
import { isWorkflowNodeElement } from '../../types/workflow-node.types';
import { HoverTip } from '../shared/hover';
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

/** 屏幕 → 画布坐标(手动计算:视口原点 + 缩放逆变换) */

/** 找光标下的画布图片元素 */

/** 找光标下的工作流节点(排除自身) */

/** 节点右缘中心(画布坐标) */

/** 节点左缘中心(画布坐标) */

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

  const setParam = (key: string, value: unknown) => {
    WorkflowNodeTransforms.setParam(board, element, key, value);
  };

  // ---- 连线拖拽(board 坐标预览,临时 SVG 贴在 board host 上) ----

  /** 输出端口:拖到目标工作流节点 → 生成图数据流(DOM 命中检测,无坐标换算) */
  const startOutputDrag = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();

      const onMove = (ev: PointerEvent) => {
        // 可选:实时更新预览线(此处不做,避免坐标偏移;靠目标高亮反馈)
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        // DOM 命中检测:落点 → 目标节点卡片
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const card = el?.closest('.wf-node-card') as HTMLElement | null;
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
          board, element, targetElement,
          'outputs:images', targetPort
        );
        MessagePlugin.success('已连线');
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [element, board]
  );

  /** 输入端口:拖到画布图片元素 → 创建可见连线,图片作为参考输入(仅生成类节点) */
  const startInputDrag = useCallback(
    (e: React.PointerEvent) => {
      if (element.nodeType !== 'image-generation' && element.nodeType !== 'image-variation') {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        // DOM 命中检测:落点 → 画布图片 SVG 元素
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        // Plait 图片渲染在 foreignObject 内的 img 或 SVG image 标签
        const imgEl = el?.closest('img') ?? el?.closest('image');
        if (!imgEl) return;
        // 通过 img src 反查画布元素
        const src = imgEl.getAttribute('src') ??
          imgEl.getAttribute('href') ?? '';
        if (!src) return;
        const target = (board.children as PlaitElement[]).find((child) => {
          if ((child as { url?: string }).url && src.includes((child as { url?: string }).url!.split('/').pop() ?? '')) return true;
          return false;
        });
        if (!target) return;
        WorkflowNodeTransforms.insertWorkflowConnection(
          board,
          target as unknown as PlaitWorkflowNode,
          element,
          'outputs:image',
          'inputs:referenceImages'
        );
        MessagePlugin.success('已绑定参考图');
      };
      const onMove = (ev: PointerEvent) => {
        // 跟踪不做视觉预览(避免坐标偏移)
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
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
      {/* 输入端口(左侧,蓝色,仅生成类节点) */}
      {isGenerative && (
        <HoverTip content="拖到画布图片绑定参考输入" showArrow={false}>
          <div
            className="wf-node-port wf-node-port--in"
            onPointerDown={startInputDrag}
          />
        </HoverTip>
      )}

      {/* 输出端口(右侧,橙色,拖到目标工作流节点) */}
      <HoverTip content="拖到目标节点建立连线" showArrow={false}>
        <div
          className="wf-node-port wf-node-port--out"
          onPointerDown={startOutputDrag}
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
    </div>
  );
};

export default WorkflowNodeContent;

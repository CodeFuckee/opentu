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
import {
  PlaitBoard,
  PlaitElement,
  Point,
  RectangleClient,
} from '@plait/core';
import type { PlaitWorkflowNode } from '../../types/workflow-node.types';
import { isWorkflowNodeElement } from '../../types/workflow-node.types';
import { HoverTip } from '../shared/hover';
import { WorkflowNodeTransforms } from '../../data/workflow-node-transforms';
import { workflowRunService } from '../../services/workflow-orchestrator/workflow-run-service';

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
function toBoardPoint(
  board: PlaitBoard,
  clientX: number,
  clientY: number
): Point {
  const container = PlaitBoard.getBoardContainer(board).getBoundingClientRect();
  const zoom = board.viewport.zoom;
  const origination = board.viewport.origination ?? [0, 0];
  return [
    (clientX - container.left) / zoom + origination[0],
    (clientY - container.top) / zoom + origination[1],
  ];
}

/** 找光标下的画布图片元素 */
function findImageAtPoint(board: PlaitBoard, point: Point): PlaitElement | null {
  for (const child of board.children as PlaitElement[]) {
    if ((child as { type?: string }).type !== 'image') continue;
    const rect = RectangleClient.getRectangleByPoints(child.points as Point[]);
    if (
      point[0] >= rect.x &&
      point[0] <= rect.x + rect.width &&
      point[1] >= rect.y &&
      point[1] <= rect.y + rect.height
    ) {
      return child;
    }
  }
  return null;
}

/** 找光标下的工作流节点(排除自身) */
function findWorkflowNodeAtPoint(
  board: PlaitBoard,
  point: Point,
  excludeId: string
): PlaitWorkflowNode | null {
  for (const child of board.children as PlaitElement[]) {
    if (!isWorkflowNodeElement(child) || child.id === excludeId) continue;
    const rect = RectangleClient.getRectangleByPoints(child.points as Point[]);
    if (
      point[0] >= rect.x &&
      point[0] <= rect.x + rect.width &&
      point[1] >= rect.y &&
      point[1] <= rect.y + rect.height
    ) {
      return child;
    }
  }
  return null;
}

/** 节点右缘中心(画布坐标) */
function nodeRightCenter(element: PlaitWorkflowNode): Point {
  const rect = RectangleClient.getRectangleByPoints(element.points);
  return [rect.x + rect.width, rect.y + rect.height / 2];
}

/** 节点左缘中心(画布坐标) */
function nodeLeftCenter(element: PlaitWorkflowNode): Point {
  const rect = RectangleClient.getRectangleByPoints(element.points);
  return [rect.x, rect.y + rect.height / 2];
}

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
  const tempSvgRef = useRef<SVGSVGElement | null>(null);

  const createTempSvg = useCallback(() => {
    const host = document.querySelector('.plait-board-container svg') ?? PlaitBoard.getActiveHost(board);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.overflow = 'visible';
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('stroke', '#b45309');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-dasharray', '6 4');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', '5');
    circle.setAttribute('fill', '#b45309');
    svg.append(line, circle);
    (host as HTMLElement).appendChild(svg);
    tempSvgRef.current = svg;
    return { svg, line, circle };
  }, [board]);

  const removeTempSvg = useCallback(() => {
    tempSvgRef.current?.remove();
    tempSvgRef.current = null;
  }, []);

  /** 输出端口:拖到目标工作流节点 → 生成图数据流 */
  const startOutputDrag = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const start = nodeRightCenter(element);
      const { line, circle } = createTempSvg();
      line.setAttribute('x1', String(start[0]));
      line.setAttribute('y1', String(start[1]));

      const onMove = (ev: PointerEvent) => {
        const pt = toBoardPoint(board, ev.clientX, ev.clientY);
        line.setAttribute('x2', String(pt[0]));
        line.setAttribute('y2', String(pt[1]));
        circle.setAttribute('cx', String(pt[0]));
        circle.setAttribute('cy', String(pt[1]));
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        removeTempSvg();
        const pt = toBoardPoint(board, ev.clientX, ev.clientY);
        const target = findWorkflowNodeAtPoint(board, pt, element.id);
        if (!target) return;
        // 端口类型按目标节点类型推断:存/插/预览接收 image[]
        const targetPort =
          target.nodeType === 'image-generation' || target.nodeType === 'image-variation'
            ? 'inputs:referenceImages'
            : 'inputs:images';
        WorkflowNodeTransforms.insertWorkflowConnection(
          board, element, target,
          'outputs:images', targetPort
        );
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [element, board, createTempSvg, removeTempSvg]
  );

  /** 输入端口:拖到画布图片元素 → 绑定该图为参考输入(仅生成类节点) */
  const startInputDrag = useCallback(
    (e: React.PointerEvent) => {
      if (element.nodeType !== 'image-generation' && element.nodeType !== 'image-variation') {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      const start = nodeLeftCenter(element);
      const { line, circle } = createTempSvg();
      line.setAttribute('x1', String(start[0]));
      line.setAttribute('y1', String(start[1]));

      const onMove = (ev: PointerEvent) => {
        const pt = toBoardPoint(board, ev.clientX, ev.clientY);
        line.setAttribute('x2', String(pt[0]));
        line.setAttribute('y2', String(pt[1]));
        circle.setAttribute('cx', String(pt[0]));
        circle.setAttribute('cy', String(pt[1]));
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        removeTempSvg();
        const pt = toBoardPoint(board, ev.clientX, ev.clientY);
        const imageEl = findImageAtPoint(board, pt);
        if (!imageEl) return;
        // 提取图片 URL 并写入节点参数
        const url = (imageEl as { url?: string }).url;
        if (url) {
          const existing = (element.params.referenceImages as string[]) ?? [];
          WorkflowNodeTransforms.setParam(
            board, element, 'referenceImages', [...existing, url]
          );
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [element, board, createTempSvg, removeTempSvg]
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

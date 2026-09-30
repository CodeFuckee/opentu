/**
 * #103 画布即编辑器:顶部编辑横幅(docs/canvas-edit-mode-design.md)。
 *
 * editing 态(黄):提示+「完成合并」+「取消编辑」;Esc=取消编辑(capture 拦截,
 * 避免触发清选区)。merged 态(绿):一次性「撤销合并」;关闭后横幅消失
 * (快照作废)。全局挂载一次,由 controller 状态驱动。
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Layers, Check, X, Undo2 } from 'lucide-react';
import { useDrawnix } from '../../hooks/use-drawnix';
import {
  getCanvasEditState,
  subscribeCanvasEdit,
  exitCanvasEditMode,
  completeCanvasEditFlatten,
  undoCanvasEditFlatten,
  currentSessionOverlays,
} from './canvas-edit-mode-controller';
import './canvas-edit-banner.scss';

export function CanvasEditBanner() {
  const { board } = useDrawnix();
  const state = useSyncExternalStore(subscribeCanvasEdit, getCanvasEditState);
  const editing = state.phase === 'editing';
  const merged = state.phase === 'merged';

  // Esc 退出编辑态(capture 拦截一次,避免同时触发清选区)
  useEffect(() => {
    if (!editing) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        exitCanvasEditMode();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing]);

  const handleComplete = useCallback(() => {
    if (board) {
      void completeCanvasEditFlatten(board);
    }
  }, [board]);

  const handleUndo = useCallback(() => {
    if (!board) {
      return;
    }
    void (async () => {
      // Transforms.insertNode 为通用元素插入(draw 的 insertElement 内部同款,
      // 但类型限几何元素,快照恢复需接受任意叠加元素)
      const { Transforms } = await import('@plait/core');
      undoCanvasEditFlatten(board, (elements) => {
        for (const el of elements) {
          try {
            Transforms.insertNode(board, el, [(board.children as unknown[]).length]);
          } catch (error) {
            console.warn('[CanvasEdit] 撤销恢复元素失败:', el.id, error);
          }
        }
      });
    })();
  }, [board]);

  if (!editing && !merged) {
    return null;
  }

  const overlayCount = board ? currentSessionOverlays(board).length : 0;

  return createPortal(
    <div
      className={`canvas-edit-banner ${editing ? 'canvas-edit-banner--editing' : 'canvas-edit-banner--merged'}`}
      data-testid="canvas-edit-banner"
    >
      {editing ? (
        <>
          <Layers size={15} />
          <span className="canvas-edit-banner__text">
            正在编辑「{state.targetName}」— 用素材库/画笔/文字在图上叠加
            {overlayCount > 0 ? `(已叠加 ${overlayCount} 项)` : ''}
            ,完成后合并为一张图(Esc 取消)
          </span>
          <button
            type="button"
            className="canvas-edit-banner__btn canvas-edit-banner__btn--primary"
            onClick={handleComplete}
            data-track="canvas_edit_complete"
          >
            <Check size={14} />
            完成合并
          </button>
          <button
            type="button"
            className="canvas-edit-banner__btn"
            onClick={exitCanvasEditMode}
            data-track="canvas_edit_cancel"
          >
            <X size={14} />
            取消编辑
          </button>
        </>
      ) : (
        <>
          <Undo2 size={15} />
          <span className="canvas-edit-banner__text">已合并为一张图</span>
          <button
            type="button"
            className="canvas-edit-banner__btn canvas-edit-banner__btn--primary"
            onClick={handleUndo}
            data-track="canvas_edit_undo"
          >
            撤销合并
          </button>
          <button
            type="button"
            className="canvas-edit-banner__btn"
            onClick={exitCanvasEditMode}
            data-track="canvas_edit_dismiss"
          >
            <X size={14} />
          </button>
        </>
      )}
    </div>,
    document.body
  );
}

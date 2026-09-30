/**
 * #103 画布即编辑器:编辑态会话控制器(docs/canvas-edit-mode-design.md)。
 *
 * 模块级单例:进入/退出/拍平/撤销的状态机与订阅(横幅经 useSyncExternalStore
 * 订阅重渲)。编辑态不锁工具——拍平白名单(canvas-edit-utils)兜底正确性:
 * 只合并「会话新增 ∧ 与目标图相交 ∧ 仍存在」的元素。
 */
import type { PlaitBoard, PlaitElement } from '@plait/core';
import {
  computeSessionAddedIds,
  selectFlattenElements,
  buildFlattenSnapshot,
  elementRect,
  type FlattenSnapshot,
} from './canvas-edit-utils';
import { flattenAndReplace } from './flatten-and-replace';

export type CanvasEditPhase = 'idle' | 'editing' | 'merged';

export interface CanvasEditState {
  phase: CanvasEditPhase;
  /** 编辑目标图元素 id(editing 态必有) */
  targetId: string | null;
  /** 目标图名称(横幅展示) */
  targetName: string;
  /** merged 态的一次性撤销快照(撤销或再次进入编辑后作废) */
  snapshot: FlattenSnapshot | null;
  /** 合并后新图元素 id(撤销时删除) */
  mergedImageId: string | null;
}

interface CanvasEditSession {
  targetId: string;
  targetName: string;
  beforeIds: Set<string>;
}

let state: CanvasEditState = {
  phase: 'idle',
  targetId: null,
  targetName: '',
  snapshot: null,
  mergedImageId: null,
};
let session: CanvasEditSession | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<CanvasEditState>) {
  state = { ...state, ...next };
  for (const fn of listeners) {
    fn();
  }
}

export function subscribeCanvasEdit(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCanvasEditState(): CanvasEditState {
  return state;
}

/** 递归收集全部元素 id(画布元素含 children 嵌套) */
export function collectElementIds(children: PlaitElement[]): Set<string> {
  const ids = new Set<string>();
  const walk = (els: PlaitElement[]) => {
    for (const el of els) {
      if (el.id) {
        ids.add(el.id);
      }
      if (el.children?.length) {
        walk(el.children as PlaitElement[]);
      }
    }
  };
  walk(children);
  return ids;
}

/** 递归摊平画布元素(供白名单过滤) */
export function flattenBoardElements(
  children: PlaitElement[]
): PlaitElement[] {
  const out: PlaitElement[] = [];
  const walk = (els: PlaitElement[]) => {
    for (const el of els) {
      out.push(el);
      if (el.children?.length) {
        walk(el.children as PlaitElement[]);
      }
    }
  };
  walk(children);
  return out;
}

/** 按编辑态语义重算当前会话叠加白名单(供拍平/横幅计数展示) */
export function currentSessionOverlays(board: PlaitBoard): PlaitElement[] {
  if (!session || state.phase !== 'editing') {
    return [];
  }
  const target = findElementById(board.children as PlaitElement[], session.targetId);
  if (!target) {
    return [];
  }
  const current = flattenBoardElements(board.children as PlaitElement[]);
  return selectFlattenElements(
    target,
    current,
    computeSessionAddedIds(session.beforeIds, collectElementIds(board.children as PlaitElement[]))
  );
}

export function findElementById(
  children: PlaitElement[],
  id: string
): PlaitElement | null {
  for (const el of children) {
    if (el.id === id) {
      return el;
    }
    if (el.children?.length) {
      const hit = findElementById(el.children as PlaitElement[], id);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

/** 进入编辑态:记录目标图与进入时元素快照(判定"会话新增"的基准) */
export function enterCanvasEditMode(board: PlaitBoard, targetImage: PlaitElement): void {
  if (!targetImage.id) {
    return;
  }
  session = {
    targetId: targetImage.id,
    targetName:
      (targetImage as { name?: string }).name ||
      (targetImage as { url?: string }).url?.slice(-24) ||
      '图片',
    beforeIds: collectElementIds(board.children as PlaitElement[]),
  };
  setState({
    phase: 'editing',
    targetId: session.targetId,
    targetName: session.targetName,
    snapshot: null,
    mergedImageId: null,
  });
}

/** 取消编辑:不合并直接退出(叠加元素保留在画布,用户可自行处理) */
export function exitCanvasEditMode(): void {
  session = null;
  setState({
    phase: 'idle',
    targetId: null,
    targetName: '',
    snapshot: null,
    mergedImageId: null,
  });
}

/** 完成合并:拍平目标图+叠加 → 桶直链 → 原位替换;快照供一次性撤销 */
export async function completeCanvasEditFlatten(board: PlaitBoard): Promise<void> {
  if (!session || state.phase !== 'editing') {
    return;
  }
  const target = findElementById(board.children as PlaitElement[], session.targetId);
  if (!target) {
    exitCanvasEditMode();
    return;
  }
  const overlays = currentSessionOverlays(board);
  const removed = [target, ...overlays];
  const snapshot = buildFlattenSnapshot(removed, elementRect(target));
  const beforeInsert = collectElementIds(board.children as PlaitElement[]);
  try {
    const ok = await flattenAndReplace(board, target, overlays);
    if (!ok) {
      return; // 拍平/上传失败:保持编辑态,横幅已提示错误
    }
  } catch (error) {
    console.warn('[CanvasEdit] 合并失败(保持编辑态):', error);
    return;
  }
  const afterInsert = collectElementIds(board.children as PlaitElement[]);
  const newIds = [...afterInsert].filter((id) => !beforeInsert.has(id));
  session = null;
  setState({
    phase: 'merged',
    snapshot,
    mergedImageId: newIds[0] ?? null,
  });
}

/** 撤销合并(一次性):删合并图,原样重插目标图与叠加元素 */
export function undoCanvasEditFlatten(
  board: PlaitBoard,
  restore: (elements: PlaitElement[]) => void
): void {
  const snap = state.snapshot;
  if (state.phase !== 'merged' || !snap) {
    return;
  }
  const mergedImage = state.mergedImageId
    ? findElementById(board.children as PlaitElement[], state.mergedImageId)
    : null;
  if (mergedImage) {
    import('@plait/core').then(({ CoreTransforms }) => {
      CoreTransforms.removeElements(board, [mergedImage]);
      restore(snap.removedElements);
    });
  } else {
    restore(snap.removedElements);
  }
  setState({
    phase: 'idle',
    targetId: null,
    targetName: '',
    snapshot: null,
    mergedImageId: null,
  });
}

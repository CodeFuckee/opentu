/**
 * 项目抽屉画板选择纯逻辑
 *
 * 供 ProjectDrawer 使用，独立成模块以便单测覆盖：
 * - collectBoardIds：全选集合（过滤树中的全部画板，不依赖目录展开状态）
 * - isAllSelected：当前选择是否已覆盖全部画板
 * - resolveBoardClickAction：画板点击语义（普通/批量模式/Ctrl/Shift 统一裁决）
 */
import type { Board, TreeNode } from '../../types/workspace.types';

/**
 * 收集树中全部画板 id（先序遍历）。
 *
 * 与 Shift 范围选择使用的「可见画板」不同：全选不依赖目录展开状态，
 * 折叠目录内的画板同样纳入（对批量删除而言，全选遗漏折叠内容比多选更危险）。
 * 搜索过滤由调用方传入过滤后的树实现。
 */
export function collectBoardIds(nodes: TreeNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.type === 'board') {
      result.push((node.data as Board).id);
    } else if (node.type === 'folder') {
      const folderNode = node as Extract<TreeNode, { type: 'folder' }>;
      if (folderNode.children) {
        result.push(...collectBoardIds(folderNode.children));
      }
    }
  }
  return result;
}

/**
 * 当前选择是否已覆盖全部画板。
 * 按传入的全集判定：选中集合含视图外多余 id 不影响结果；全集为空时返回 false。
 */
export function isAllSelected(
  selected: Set<string>,
  allBoardIds: string[]
): boolean {
  if (allBoardIds.length === 0) {
    return false;
  }
  return allBoardIds.every((id) => selected.has(id));
}

export interface BoardClickInput {
  /** 被点击的画板 */
  board: Board;
  isShift: boolean;
  isCtrlOrCmd: boolean;
  /** 批量管理模式：普通点击等价于 Ctrl+点击（toggle），不再切换画板 */
  batchMode: boolean;
  /** 上次点击的画板 id（Shift 范围选择起点） */
  lastClickedBoardId: string | null;
  /** 可见画板列表（Shift 范围选择的坐标轴） */
  flatBoards: Board[];
  currentSelection: Set<string>;
}

export type BoardClickResult =
  | {
      action: 'switch';
      board: Board;
      nextSelection: Set<string>;
      lastClickedBoardId: string;
    }
  | {
      action: 'toggle';
      board: Board;
      nextSelection: Set<string>;
      lastClickedBoardId: string;
    }
  | { action: 'range'; nextSelection: Set<string> }
  /** 无起点等场景下范围选择无法计算，维持现状 */
  | { action: 'none' };

/**
 * 画板点击语义裁决（与历史行为保持一致的纯函数版本）：
 * - Shift+点击（有起点且两端均在可见列表）：范围加入选择；
 * - Shift+点击无起点：退化为普通点击；
 * - Ctrl/Cmd+点击：toggle；
 * - 普通点击：批量模式下 toggle，否则切换画板并清空选择。
 */
export function resolveBoardClickAction(
  input: BoardClickInput
): BoardClickResult {
  const {
    board,
    isShift,
    isCtrlOrCmd,
    batchMode,
    lastClickedBoardId,
    flatBoards,
    currentSelection,
  } = input;

  if (isShift && lastClickedBoardId) {
    const startIndex = flatBoards.findIndex((b) => b.id === lastClickedBoardId);
    const endIndex = flatBoards.findIndex((b) => b.id === board.id);
    if (startIndex !== -1 && endIndex !== -1) {
      const [from, to] =
        startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
      const rangeIds = flatBoards.slice(from, to + 1).map((b) => b.id);
      const nextSelection = new Set(currentSelection);
      rangeIds.forEach((id) => nextSelection.add(id));
      return { action: 'range', nextSelection };
    }
    return { action: 'none' };
  }

  const toggle = (): BoardClickResult => {
    const nextSelection = new Set(currentSelection);
    if (nextSelection.has(board.id)) {
      nextSelection.delete(board.id);
    } else {
      nextSelection.add(board.id);
    }
    return {
      action: 'toggle',
      board,
      nextSelection,
      lastClickedBoardId: board.id,
    };
  };

  if (isCtrlOrCmd) {
    return toggle();
  }

  if (batchMode) {
    return toggle();
  }

  return {
    action: 'switch',
    board,
    nextSelection: new Set<string>(),
    lastClickedBoardId: board.id,
  };
}

/**
 * 项目抽屉画板选择纯逻辑单测
 *
 * 覆盖批量管理功能的三个纯函数：
 * - collectBoardIds：全选集合计算（含目录嵌套/折叠/搜索过滤边界）
 * - isAllSelected：全选状态判定
 * - resolveBoardClickAction：画板点击语义（普通/批量模式/Ctrl/Shift）
 */
import { describe, expect, it } from 'vitest';
import type { Board, Folder, TreeNode } from '../../types/workspace.types';
import {
  collectBoardIds,
  isAllSelected,
  resolveBoardClickAction,
} from './selection';

const makeBoard = (id: string): Board =>
  ({ id, name: `画板-${id}` }) as unknown as Board;

const boardNode = (id: string): TreeNode =>
  ({ type: 'board', data: makeBoard(id) }) as TreeNode;

const folderNode = (
  id: string,
  children: TreeNode[],
  isExpanded = true
): TreeNode =>
  ({
    type: 'folder',
    data: { id, name: `目录-${id}`, isExpanded } as Folder,
    children,
  }) as TreeNode;

describe('collectBoardIds（全选集合计算）', () => {
  it('空树返回空数组', () => {
    expect(collectBoardIds([])).toEqual([]);
  });

  it('仅根级画板时按先序收集全部 id', () => {
    const tree = [boardNode('a'), boardNode('b'), boardNode('c')];
    expect(collectBoardIds(tree)).toEqual(['a', 'b', 'c']);
  });

  it('展开目录的子画板被收集', () => {
    const tree = [folderNode('f1', [boardNode('a'), boardNode('b')], true)];
    expect(collectBoardIds(tree)).toEqual(['a', 'b']);
  });

  it('折叠目录的子画板同样被收集（全选语义不依赖目录展开状态）', () => {
    const tree = [folderNode('f1', [boardNode('a'), boardNode('b')], false)];
    expect(collectBoardIds(tree)).toEqual(['a', 'b']);
  });

  it('多层嵌套目录按先序深度收集', () => {
    const tree = [
      boardNode('root1'),
      folderNode('f1', [
        boardNode('f1-a'),
        folderNode('f1-f2', [boardNode('deep')], false),
      ]),
      boardNode('root2'),
    ];
    expect(collectBoardIds(tree)).toEqual([
      'root1',
      'f1-a',
      'deep',
      'root2',
    ]);
  });
});

describe('isAllSelected（全选状态判定）', () => {
  it('无可选画板（空集合）时返回 false', () => {
    expect(isAllSelected(new Set(), [])).toBe(false);
  });

  it('全部选中返回 true', () => {
    expect(isAllSelected(new Set(['a', 'b']), ['a', 'b'])).toBe(true);
  });

  it('部分选中返回 false', () => {
    expect(isAllSelected(new Set(['a']), ['a', 'b'])).toBe(false);
  });

  it('选中集合包含视图外的多余 id 时不影响判定', () => {
    expect(isAllSelected(new Set(['a', 'b', 'hidden']), ['a', 'b'])).toBe(true);
  });

  it('全选后重复传入相同 id（Set 去重）仍返回 true', () => {
    expect(isAllSelected(new Set(['a', 'a', 'b']), ['a', 'b', 'b'])).toBe(true);
  });
});

describe('resolveBoardClickAction（画板点击语义）', () => {
  const flatBoards = [makeBoard('b1'), makeBoard('b2'), makeBoard('b3')];

  describe('批量模式关闭（回归现有语义）', () => {
    it('普通点击 = 切换画板并清空选择', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b2'),
        isShift: false,
        isCtrlOrCmd: false,
        batchMode: false,
        lastClickedBoardId: 'b1',
        flatBoards,
        currentSelection: new Set(['b1']),
      });
      expect(result).toMatchObject({
        action: 'switch',
        lastClickedBoardId: 'b2',
      });
      expect(result.nextSelection.size).toBe(0);
    });

    it('Ctrl+点击未选中画板 = 加入选择', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b2'),
        isShift: false,
        isCtrlOrCmd: true,
        batchMode: false,
        lastClickedBoardId: null,
        flatBoards,
        currentSelection: new Set(),
      });
      expect(result.action).toBe('toggle');
      expect([...result.nextSelection]).toEqual(['b2']);
      expect(result.lastClickedBoardId).toBe('b2');
    });

    it('Ctrl+点击已选中画板 = 移出选择', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b1'),
        isShift: false,
        isCtrlOrCmd: true,
        batchMode: false,
        lastClickedBoardId: 'b1',
        flatBoards,
        currentSelection: new Set(['b1', 'b3']),
      });
      expect(result.action).toBe('toggle');
      expect([...result.nextSelection]).toEqual(['b3']);
    });

    it('Shift+点击有起点时 = 范围加入选择（正序）', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b3'),
        isShift: true,
        isCtrlOrCmd: false,
        batchMode: false,
        lastClickedBoardId: 'b1',
        flatBoards,
        currentSelection: new Set(),
      });
      expect(result.action).toBe('range');
      expect([...result.nextSelection]).toEqual(['b1', 'b2', 'b3']);
    });

    it('Shift+点击有起点时 = 范围加入选择（逆序）', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b1'),
        isShift: true,
        isCtrlOrCmd: false,
        batchMode: false,
        lastClickedBoardId: 'b3',
        flatBoards,
        currentSelection: new Set(['b3']),
      });
      expect(result.action).toBe('range');
      expect([...result.nextSelection]).toEqual(['b3', 'b1', 'b2']);
    });

    it('Shift+点击无起点时退化为普通点击（切换画板）', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b2'),
        isShift: true,
        isCtrlOrCmd: false,
        batchMode: false,
        lastClickedBoardId: null,
        flatBoards,
        currentSelection: new Set(),
      });
      expect(result.action).toBe('switch');
    });

    it('Shift+点击的画板不在可见列表中时不做任何事', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('ghost'),
        isShift: true,
        isCtrlOrCmd: false,
        batchMode: false,
        lastClickedBoardId: 'b1',
        flatBoards,
        currentSelection: new Set(),
      });
      expect(result.action).toBe('none');
    });
  });

  describe('批量模式开启（新语义）', () => {
    it('普通点击未选中画板 = 加入选择（不切换画板）', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b2'),
        isShift: false,
        isCtrlOrCmd: false,
        batchMode: true,
        lastClickedBoardId: 'b1',
        flatBoards,
        currentSelection: new Set(),
      });
      expect(result.action).toBe('toggle');
      expect([...result.nextSelection]).toEqual(['b2']);
      expect(result.lastClickedBoardId).toBe('b2');
    });

    it('普通点击已选中画板 = 移出选择', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b2'),
        isShift: false,
        isCtrlOrCmd: false,
        batchMode: true,
        lastClickedBoardId: 'b2',
        flatBoards,
        currentSelection: new Set(['b1', 'b2']),
      });
      expect(result.action).toBe('toggle');
      expect([...result.nextSelection]).toEqual(['b1']);
    });

    it('批量模式下 Shift+点击仍为范围选择', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b3'),
        isShift: true,
        isCtrlOrCmd: false,
        batchMode: true,
        lastClickedBoardId: 'b1',
        flatBoards,
        currentSelection: new Set(),
      });
      expect(result.action).toBe('range');
      expect([...result.nextSelection]).toEqual(['b1', 'b2', 'b3']);
    });

    it('批量模式下 Ctrl+点击与普通点击一致（toggle）', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b1'),
        isShift: false,
        isCtrlOrCmd: true,
        batchMode: true,
        lastClickedBoardId: null,
        flatBoards,
        currentSelection: new Set(),
      });
      expect(result.action).toBe('toggle');
      expect([...result.nextSelection]).toEqual(['b1']);
    });

    it('空可见列表时批量模式普通点击仍可 toggle（不依赖 flatBoards）', () => {
      const result = resolveBoardClickAction({
        board: makeBoard('b1'),
        isShift: false,
        isCtrlOrCmd: false,
        batchMode: true,
        lastClickedBoardId: null,
        flatBoards: [],
        currentSelection: new Set(),
      });
      expect(result.action).toBe('toggle');
      expect([...result.nextSelection]).toEqual(['b1']);
    });
  });
});

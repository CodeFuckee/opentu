import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaitBoard } from '@plait/core';

import { buildPencilPlugin } from './with-pencil';

vi.mock('@plait/core', () => ({
  isPencilEvent: (event: PointerEvent) => event.pointerType === 'pen',
  isWheelPointer: (event: PointerEvent) => event.button === 1,
  PlaitBoard: {
    getBoardContainer: (board: TestBoard) => board.container,
  },
}));

type TestBoard = PlaitBoard & {
  container: HTMLDivElement;
  basePointerDown: ReturnType<typeof vi.fn>;
  pointerDown: (event: PointerEvent) => void;
};

function createBoard(): TestBoard {
  const basePointerDown = vi.fn();
  return {
    container: document.createElement('div'),
    basePointerDown,
    pointerDown: basePointerDown,
  } as unknown as TestBoard;
}

function createPointerEvent(
  pointerType: string,
  button = 0
): PointerEvent {
  return {
    pointerType,
    button,
  } as PointerEvent;
}

describe('buildPencilPlugin', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps blocking regular mouse drawing after pencil mode is enabled', () => {
    const updateAppState = vi.fn();
    const board = buildPencilPlugin(updateAppState)(createBoard()) as TestBoard;

    board.pointerDown(createPointerEvent('pen'));
    board.pointerDown(createPointerEvent('mouse'));

    expect(updateAppState).toHaveBeenCalledWith({ isPencilMode: true });
    expect(board.basePointerDown).toHaveBeenCalledTimes(1);
  });

  it('allows middle mouse panning after pencil mode is enabled', () => {
    const board = buildPencilPlugin(vi.fn())(createBoard()) as TestBoard;

    board.pointerDown(createPointerEvent('pen'));
    const middleMouseEvent = createPointerEvent('mouse', 1);
    board.pointerDown(middleMouseEvent);

    expect(board.basePointerDown).toHaveBeenLastCalledWith(middleMouseEvent);
  });

  it('allows space-hand panning after pencil mode is enabled', () => {
    const board = buildPencilPlugin(vi.fn())(createBoard()) as TestBoard;

    board.pointerDown(createPointerEvent('pen'));
    board.container.classList.add('viewport-moving');
    const mouseEvent = createPointerEvent('mouse');
    board.pointerDown(mouseEvent);

    expect(board.basePointerDown).toHaveBeenLastCalledWith(mouseEvent);
  });
});

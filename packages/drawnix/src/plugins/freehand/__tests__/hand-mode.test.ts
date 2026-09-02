import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaitBoard } from '@plait/core';
import { FreehandShape } from '../type';

import { withFreehandCreate } from '../with-freehand-create';
import { withFreehandErase } from '../with-freehand-erase';

const { insertNodeMock, removeElementsMock } = vi.hoisted(() => ({
  insertNodeMock: vi.fn((board: TestBoard, node: unknown) => {
    board.children.push(node);
  }),
  removeElementsMock: vi.fn((board: TestBoard, elements: unknown[]) => {
    board.children = board.children.filter((child) => !elements.includes(child));
  }),
}));

vi.mock('@plait/core', () => ({
  DEFAULT_COLOR: '#000000',
  ThemeColorMode: {
    default: 'default',
    colorful: 'colorful',
    soft: 'soft',
    retro: 'retro',
    dark: 'dark',
    starry: 'starry',
  },
  PlaitBoard: {
    getPointer: (board: TestBoard) => board.pointer,
    getBoardContainer: (board: TestBoard) => board.container,
    getElementTopHost: (board: TestBoard) => board.host,
    isInPointer: (board: TestBoard, pointers: string[]) =>
      pointers.includes(board.pointer),
  },
  PlaitElement: {
    getElementG: (element: TestElement) => element.g,
  },
  Transforms: {
    insertNode: insertNodeMock,
  },
  CoreTransforms: {
    removeElements: removeElementsMock,
  },
  distanceBetweenPointAndPoint: (
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ) => Math.hypot(x2 - x1, y2 - y1),
  isWheelPointer: (event: PointerEvent) => event.button === 1,
  throttleRAF: (_board: TestBoard, _key: string, callback: () => void) =>
    callback(),
  toHostPoint: (_board: TestBoard, x: number, y: number) => [x, y],
  toViewBoxPoint: (_board: TestBoard, point: [number, number]) => point,
}));

vi.mock('@plait/common', () => ({
  isDrawingMode: () => true,
  StrokeStyle: {
    solid: 'solid',
    dashed: 'dashed',
  },
}));

vi.mock('@plait/draw', () => ({
  PlaitDrawElement: {
    isDrawElement: () => false,
    isImage: () => false,
  },
}));

vi.mock('../utils', () => ({
  createFreehandElement: (
    shape: FreehandShape,
    points: unknown[],
    options: Record<string, unknown>
  ) => ({
    id: 'freehand-new',
    type: 'freehand',
    shape,
    points,
    ...options,
  }),
  getFreehandPointers: () => [FreehandShape.feltTipPen, FreehandShape.eraser],
  isHitFreehandWithRadius: () => true,
}));

vi.mock('../freehand.generator', () => ({
  FreehandGenerator: vi.fn().mockImplementation(() => ({
    destroy: vi.fn(),
    processDrawing: vi.fn(),
  })),
}));

vi.mock('../smoother', () => ({
  FreehandSmoother: vi.fn().mockImplementation(() => ({
    process: (point: [number, number]) => point,
    reset: vi.fn(),
  })),
}));

vi.mock('../../../transforms/precise-erase', () => ({
  executePreciseErase: vi.fn(),
  findElementsInEraserPath: vi.fn(() => []),
  findUnsupportedElementsInEraserPath: vi.fn(() => []),
}));

vi.mock('../../../types/frame.types', () => ({
  isFrameElement: () => false,
}));

vi.mock('../../../interfaces/video', () => ({
  isPlaitVideo: () => false,
}));

type TestElement = {
  id: string;
  type: string;
  shape?: FreehandShape;
  points?: [number, number][];
  g: SVGGElement;
};

type TestBoard = PlaitBoard & {
  pointer: string;
  children: unknown[];
  host: SVGGElement;
  container: HTMLDivElement;
  baseHandlers: {
    pointerDown: ReturnType<typeof vi.fn>;
    pointerMove: ReturnType<typeof vi.fn>;
    pointerUp: ReturnType<typeof vi.fn>;
    globalPointerUp: ReturnType<typeof vi.fn>;
  };
  pointerDown: (event: PointerEvent) => void;
  pointerMove: (event: PointerEvent) => void;
  pointerUp: (event: PointerEvent) => void;
  globalPointerUp: (event: PointerEvent) => void;
};

function createBoard(pointer: FreehandShape): TestBoard {
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const container = document.createElement('div');
  const baseHandlers = {
    pointerDown: vi.fn(),
    pointerMove: vi.fn(),
    pointerUp: vi.fn(),
    globalPointerUp: vi.fn(),
  };
  return {
    pointer,
    children: [],
    host,
    container,
    baseHandlers,
    ...baseHandlers,
  } as unknown as TestBoard;
}

function createPointerEvent(x: number, y: number, button = 0): PointerEvent {
  return {
    x,
    y,
    button,
  } as PointerEvent;
}

function createFreehandElement(id = 'freehand-existing'): TestElement {
  return {
    id,
    type: 'freehand',
    shape: FreehandShape.feltTipPen,
    points: [
      [10, 10],
      [30, 30],
    ],
    g: document.createElementNS('http://www.w3.org/2000/svg', 'g'),
  };
}

describe('freehand temporary hand panning', () => {
  beforeEach(() => {
    insertNodeMock.mockClear();
    removeElementsMock.mockClear();
    document.body.innerHTML = '';
  });

  it('delegates space-hand panning while drawing with the brush', () => {
    const board = withFreehandCreate(
      createBoard(FreehandShape.feltTipPen)
    ) as TestBoard;
    board.container.classList.add('viewport-moving');

    const pointerDownEvent = createPointerEvent(100, 100);
    const pointerMoveEvent = createPointerEvent(120, 120);
    const pointerUpEvent = createPointerEvent(120, 120);

    board.pointerDown(pointerDownEvent);
    board.pointerMove(pointerMoveEvent);
    board.pointerUp(pointerUpEvent);

    expect(board.baseHandlers.pointerDown).toHaveBeenLastCalledWith(
      pointerDownEvent
    );
    expect(board.baseHandlers.pointerMove).toHaveBeenLastCalledWith(
      pointerMoveEvent
    );
    expect(board.baseHandlers.pointerUp).toHaveBeenLastCalledWith(
      pointerUpEvent
    );
    expect(insertNodeMock).not.toHaveBeenCalled();
  });

  it('delegates middle mouse panning while drawing with the brush', () => {
    const board = withFreehandCreate(
      createBoard(FreehandShape.feltTipPen)
    ) as TestBoard;

    const pointerDownEvent = createPointerEvent(100, 100, 1);
    const pointerMoveEvent = createPointerEvent(120, 120, 1);
    const pointerUpEvent = createPointerEvent(120, 120, 1);

    board.pointerDown(pointerDownEvent);
    board.pointerMove(pointerMoveEvent);
    board.pointerUp(pointerUpEvent);

    expect(board.baseHandlers.pointerDown).toHaveBeenLastCalledWith(
      pointerDownEvent
    );
    expect(board.baseHandlers.pointerMove).toHaveBeenLastCalledWith(
      pointerMoveEvent
    );
    expect(board.baseHandlers.pointerUp).toHaveBeenLastCalledWith(
      pointerUpEvent
    );
    expect(insertNodeMock).not.toHaveBeenCalled();
  });

  it('delegates space-hand panning while erasing', () => {
    const board = withFreehandErase(
      createBoard(FreehandShape.eraser)
    ) as TestBoard;
    board.children = [createFreehandElement()];
    board.container.classList.add('viewport-moving');

    const pointerDownEvent = createPointerEvent(100, 100);
    const pointerMoveEvent = createPointerEvent(120, 120);
    const pointerUpEvent = createPointerEvent(120, 120);

    board.pointerDown(pointerDownEvent);
    board.pointerMove(pointerMoveEvent);
    board.pointerUp(pointerUpEvent);

    expect(board.baseHandlers.pointerDown).toHaveBeenLastCalledWith(
      pointerDownEvent
    );
    expect(board.baseHandlers.pointerMove).toHaveBeenLastCalledWith(
      pointerMoveEvent
    );
    expect(board.baseHandlers.pointerUp).toHaveBeenLastCalledWith(
      pointerUpEvent
    );
    expect(removeElementsMock).not.toHaveBeenCalled();
  });

  it('delegates middle mouse panning while erasing', () => {
    const board = withFreehandErase(
      createBoard(FreehandShape.eraser)
    ) as TestBoard;
    board.children = [createFreehandElement()];

    const pointerDownEvent = createPointerEvent(100, 100, 1);
    const pointerMoveEvent = createPointerEvent(120, 120, 1);
    const pointerUpEvent = createPointerEvent(120, 120, 1);

    board.pointerDown(pointerDownEvent);
    board.pointerMove(pointerMoveEvent);
    board.pointerUp(pointerUpEvent);

    expect(board.baseHandlers.pointerDown).toHaveBeenLastCalledWith(
      pointerDownEvent
    );
    expect(board.baseHandlers.pointerMove).toHaveBeenLastCalledWith(
      pointerMoveEvent
    );
    expect(board.baseHandlers.pointerUp).toHaveBeenLastCalledWith(
      pointerUpEvent
    );
    expect(removeElementsMock).not.toHaveBeenCalled();
  });
});

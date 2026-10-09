/**
 * SmartCutoutHost 单元测试:订阅 launcher 请求→打开编辑器(直落抠图模式)→
 * 保存链路接线(插入=缓存虚拟路径+insertImageFromUrl;覆盖=缓存+setNode 原位替换)。
 * ImageEditor 与持久化/插入/变换依赖全部 mock,只验证宿主的接线逻辑。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SmartCutoutHost } from './smart-cutout-host';
import { openSmartCutout } from './smart-cutout-launcher';

// vi.mock 工厂被提升到 const 声明之前执行,共享 mock 用 vi.hoisted 声明
const {
  editorPropsCapture,
  persistMock,
  insertImageFromUrlMock,
  setNodeMock,
  getViewportOriginationMock,
  calculateEditedImagePointsMock,
} = vi.hoisted(() => ({
  editorPropsCapture: vi.fn(),
  persistMock: vi.fn(),
  insertImageFromUrlMock: vi.fn(),
  setNodeMock: vi.fn(),
  getViewportOriginationMock: vi.fn(() => [0, 0]),
  calculateEditedImagePointsMock: vi.fn(),
}));

vi.mock('./ImageEditor', () => ({
  ImageEditor: (props: unknown) => {
    editorPropsCapture(props);
    return props.visible ? (
      <div data-testid="image-editor-stub">editor</div>
    ) : null;
  },
}));

vi.mock('./smart-cutout-persist', () => ({
  persistEditedImageToVirtualPath: (...args: unknown[]) => persistMock(...args),
}));

vi.mock('../../data/image', () => ({
  insertImageFromUrl: (...args: unknown[]) => insertImageFromUrlMock(...args),
}));

vi.mock('@plait/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@plait/core')>();
  return {
    ...actual,
    Transforms: { ...actual.Transforms, setNode: setNodeMock },
    getViewportOrigination: getViewportOriginationMock,
  };
});

vi.mock('../../utils/image', () => ({
  calculateEditedImagePoints: (...args: unknown[]) =>
    calculateEditedImagePointsMock(...args),
}));

const stubBoard = { children: [] } as unknown as import('@plait/core').PlaitBoard;

const SOURCE_ELEMENT = {
  id: 'img-1',
  url: 'http://example.com/a.png',
  points: [
    [10, 20],
    [110, 100],
  ],
  width: 100,
  height: 80,
};

beforeEach(() => {
  vi.clearAllMocks();
  persistMock.mockResolvedValue({
    stableUrl: '/__aitu_cache__/image/edited-image-1.png',
    width: 80,
    height: 60,
  });
  calculateEditedImagePointsMock.mockResolvedValue({
    newPoints: [
      [0, 0],
      [80, 60],
    ],
  });
});

describe('SmartCutoutHost', () => {
  it('无请求时不渲染编辑器', () => {
    render(<SmartCutoutHost board={stubBoard} />);
    expect(screen.queryByTestId('image-editor-stub')).toBeFalsy();
  });

  it('收到请求后以抠图模式打开编辑器,画布来源无覆盖选项', async () => {
    render(<SmartCutoutHost board={stubBoard} />);
    openSmartCutout({ imageUrl: 'http://example.com/a.png' });
    await waitFor(() =>
      expect(screen.getByTestId('image-editor-stub')).toBeTruthy()
    );
    const props = editorPropsCapture.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(props.imageUrl).toBe('http://example.com/a.png');
    expect(props.initialMode).toBe('cutout');
    expect(props.showOverwrite).toBe(false);
  });

  it('带画布来源元素时显示覆盖选项', async () => {
    render(<SmartCutoutHost board={stubBoard} />);
    openSmartCutout({
      imageUrl: 'http://example.com/a.png',
      sourceElement: SOURCE_ELEMENT,
    });
    await waitFor(() =>
      expect(screen.getByTestId('image-editor-stub')).toBeTruthy()
    );
    const props = editorPropsCapture.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(props.showOverwrite).toBe(true);
  });

  it('onInsert:持久化到虚拟路径后在原图旁插入新图片并关闭', async () => {
    render(<SmartCutoutHost board={stubBoard} />);
    openSmartCutout({
      imageUrl: 'http://example.com/a.png',
      sourceElement: SOURCE_ELEMENT,
    });
    await waitFor(() =>
      expect(screen.getByTestId('image-editor-stub')).toBeTruthy()
    );
    const props = editorPropsCapture.mock.calls.at(-1)![0] as Record<string, unknown>;
    await (props.onInsert as (u: string) => Promise<void>)('data:image/png;base64,QQ==');

    expect(persistMock).toHaveBeenCalledWith('data:image/png;base64,QQ==');
    // 插入点 = 原图右上方偏移 20(points[1][0]-points[0][0]+20 = 120)
    expect(insertImageFromUrlMock).toHaveBeenCalledTimes(1);
    const [, , insertPoint] = insertImageFromUrlMock.mock.calls[0] as [
      unknown,
      string,
      [number, number],
    ];
    expect(insertPoint).toEqual([130, 20]);
    // 插入后编辑器关闭
    await waitFor(() =>
      expect(screen.queryByTestId('image-editor-stub')).toBeFalsy()
    );
  });

  it('onInsert 无画布来源时落在视口中心附近', async () => {
    render(<SmartCutoutHost board={stubBoard} />);
    openSmartCutout({ imageUrl: 'http://example.com/a.png' });
    await waitFor(() =>
      expect(screen.getByTestId('image-editor-stub')).toBeTruthy()
    );
    const props = editorPropsCapture.mock.calls.at(-1)![0] as Record<string, unknown>;
    await (props.onInsert as (u: string) => Promise<void>)('data:image/png;base64,QQ==');

    expect(insertImageFromUrlMock).toHaveBeenCalledTimes(1);
    const [, , insertPoint] = insertImageFromUrlMock.mock.calls[0] as [
      unknown,
      string,
      [number, number],
    ];
    expect(insertPoint).toEqual([100, 100]);
  });

  it('onOverwrite:持久化后原位替换画布元素', async () => {
    const boardWithChild = {
      children: [{ id: 'img-1', url: 'http://example.com/a.png', width: 100, height: 80, points: SOURCE_ELEMENT.points }],
    } as unknown as import('@plait/core').PlaitBoard;
    render(<SmartCutoutHost board={boardWithChild} />);
    openSmartCutout({
      imageUrl: 'http://example.com/a.png',
      sourceElement: SOURCE_ELEMENT,
    });
    await waitFor(() =>
      expect(screen.getByTestId('image-editor-stub')).toBeTruthy()
    );
    const props = editorPropsCapture.mock.calls.at(-1)![0] as Record<string, unknown>;
    await (props.onOverwrite as (u: string) => Promise<void>)('data:image/png;base64,QQ==');

    expect(setNodeMock).toHaveBeenCalledTimes(1);
    const [, ops, path] = setNodeMock.mock.calls[0] as [unknown, unknown, number[]];
    expect(ops).toMatchObject({ url: '/__aitu_cache__/image/edited-image-1.png' });
    expect(path).toEqual([0]);
  });

  it('onClose 关闭编辑器并复位,可再次打开', async () => {
    render(<SmartCutoutHost board={stubBoard} />);
    openSmartCutout({ imageUrl: 'http://example.com/a.png' });
    await waitFor(() =>
      expect(screen.getByTestId('image-editor-stub')).toBeTruthy()
    );
    const props = editorPropsCapture.mock.calls.at(-1)![0] as Record<string, unknown>;
    (props.onClose as () => void)();
    await waitFor(() =>
      expect(screen.queryByTestId('image-editor-stub')).toBeFalsy()
    );

    openSmartCutout({ imageUrl: 'http://example.com/b.png' });
    await waitFor(() =>
      expect(screen.getByTestId('image-editor-stub')).toBeTruthy()
    );
    const props2 = editorPropsCapture.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(props2.imageUrl).toBe('http://example.com/b.png');
  });
});

/**
 * ImageEditorCore initialMode 单元测试:支持外部指定初始编辑模式。
 * 侧边栏「智能抠图」依赖它直落抠图模式;默认行为(裁剪)不得改变。
 * 只关注模式切换逻辑,面板/抠图控制器均 stub。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImageEditorCore } from './ImageEditorCore';

vi.mock('./resolve-editor-image-source', () => ({
  resolveEditorImageSource: vi.fn(async (url: string) => ({ src: url })),
}));

const stubController = {
  session: null,
  points: [],
  tool: 'add',
  encoding: false,
  segmenting: false,
  maskOverlayUrl: null,
  hoverOverlayUrl: null,
  error: null,
  addPoint: vi.fn(),
  hoverMove: vi.fn(),
  hoverLeave: vi.fn(),
  setTool: vi.fn(),
  clear: vi.fn(),
  confirm: vi.fn(),
  setFeather: vi.fn(),
};

vi.mock('./cutout-controller', () => ({
  useCutoutController: vi.fn(() => stubController),
}));

vi.mock('./CutoutPanel', () => ({
  CutoutPanel: () => <div data-testid="cutout-panel-stub" />,
}));

vi.mock('./CutoutStage', () => ({
  CutoutStage: () => <div data-testid="cutout-stage-stub" />,
}));

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

describe('ImageEditorCore initialMode', () => {
  it('默认初始模式为裁剪(现状回归)', () => {
    render(<ImageEditorCore imageUrl={DATA_URL} />);
    const cropTab = screen.getByRole('button', { name: '裁剪' });
    const cutoutTab = screen.getByTestId('cutout-mode-tab');
    expect(cropTab.className).toContain('active');
    expect(cutoutTab.className).not.toContain('active');
  });

  it('initialMode=cutout 时直落抠图模式', () => {
    render(<ImageEditorCore imageUrl={DATA_URL} initialMode="cutout" />);
    const cutoutTab = screen.getByTestId('cutout-mode-tab');
    expect(cutoutTab.className).toContain('active');
    // 抠图舞台与面板就位(无需手动切换)
    expect(screen.getByTestId('cutout-stage-stub')).toBeTruthy();
    expect(screen.getByTestId('cutout-panel-stub')).toBeTruthy();
    // 裁剪面板不在
    expect(screen.queryByRole('button', { name: '裁剪' })?.className).not.toContain(
      'active'
    );
  });

  it('initialMode 透传非法值时回退裁剪不崩溃', () => {
    // @ts-expect-error 故意传非法值,验证运行时兜底
    render(<ImageEditorCore imageUrl={DATA_URL} initialMode="bogus" />);
    const cropTab = screen.getByRole('button', { name: '裁剪' });
    expect(cropTab.className).toContain('active');
  });
});

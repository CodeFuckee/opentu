// @vitest-environment jsdom
import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomActionsSection } from './bottom-actions-section';
import { FEEDBACKLAND_URL } from '../../constants';

const defaultProps = {
  projectDrawerOpen: false,
  onProjectDrawerToggle: vi.fn(),
  toolboxDrawerOpen: false,
  onToolboxDrawerToggle: vi.fn(),
  taskPanelExpanded: false,
  onTaskPanelToggle: vi.fn(),
};

// 任务队列状态与任务无关，这里提供最小可用返回
vi.mock('../../hooks/useTaskQueue', () => ({
  useTaskQueue: () => ({
    activeTasks: [],
    completedTasks: [],
    failedTasks: [],
    tasks: [],
    cancelledTasks: [],
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    totalCount: 0,
    loadedCount: 0,
    loadMore: vi.fn(),
  }),
}));

// HoverTip 依赖 viewport 测量等浏览器 API，测试中直接透传子元素
vi.mock('../shared/hover', () => ({
  HoverTip: ({ children }: { children: React.ReactNode }) => children,
}));

describe('BottomActionsSection Feedbackland 按钮', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('渲染 Feedbackland 按钮（带正确的 aria-label）', () => {
    render(<BottomActionsSection {...defaultProps} />);
    const button = screen.getByTestId('toolbar-feedbackland');
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-label')).toBe('Feedbackland 反馈');
  });

  it('点击后以新标签页 + noopener 打开 FEEDBACKLAND_URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<BottomActionsSection {...defaultProps} />);
    fireEvent.click(screen.getByTestId('toolbar-feedbackland'));
    expect(openSpy).toHaveBeenCalledWith(
      FEEDBACKLAND_URL,
      '_blank',
      expect.stringContaining('noopener')
    );
    openSpy.mockRestore();
  });

  it('window.open 返回 null（弹窗被拦截）时不抛异常', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<BottomActionsSection {...defaultProps} />);
    expect(() =>
      fireEvent.click(screen.getByTestId('toolbar-feedbackland'))
    ).not.toThrow();
    openSpy.mockRestore();
  });

  it('FEEDBACKLAND_URL 必须是合法的绝对 http/https 地址（避免空值/相对路径）', () => {
    expect(FEEDBACKLAND_URL).toMatch(/^https?:\/\//);
    expect(() => new URL(FEEDBACKLAND_URL)).not.toThrow();
  });

  it('原有操作按钮（项目/工具箱/任务）不受影响', () => {
    render(<BottomActionsSection {...defaultProps} />);
    expect(screen.getByTestId('toolbar-project')).toBeTruthy();
    expect(screen.getByTestId('toolbar-toolbox')).toBeTruthy();
    expect(screen.getByTestId('toolbar-tasks')).toBeTruthy();
  });
});

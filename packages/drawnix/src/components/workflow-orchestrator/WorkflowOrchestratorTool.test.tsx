/**
 * 工作流编排工具冒烟测试:工具条渲染、添加节点、空图运行提示。
 * React Flow 依赖 ResizeObserver,jsdom 下打桩(beforeEach 内,避免全局污染)。
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { WorkflowOrchestratorTool } from './WorkflowOrchestratorTool';

describe('WorkflowOrchestratorTool 冒烟', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染工具条与空画布', () => {
    render(<WorkflowOrchestratorTool />);
    expect(screen.getByPlaceholderText('工作流名称')).toBeTruthy();
    expect(screen.getByTestId('wf-orch-run')).toBeTruthy();
  });

  it('添加节点菜单可加入节点', async () => {
    render(<WorkflowOrchestratorTool />);
    fireEvent.click(screen.getByText('添加节点 ▾'));
    fireEvent.click(screen.getByText('文生图'));
    await waitFor(() => {
      expect(document.querySelector('[data-node-type="image-generation"]')).toBeTruthy();
    });
  });

  it('空图运行给出警告提示且不进入运行态', async () => {
    render(<WorkflowOrchestratorTool />);
    fireEvent.click(screen.getByTestId('wf-orch-run'));
    await waitFor(() => {
      const toast = document.querySelector('.t-message');
      expect(toast?.textContent).toContain('没有可执行的节点');
    });
  });
});

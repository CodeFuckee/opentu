/**
 * Flowgram 编辑器组件 smoke 测试。
 *
 * flowgram 渲染层(Provider/EditorRenderer/插件)全部 mock,验证应用壳:
 * URL 加载图 → 顶栏/节点面板/参数栏渲染 → 手动保存落盘 → 图列表操作。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkflowEditorApp } from './index';
import {
  saveOrchestratorGraph,
  loadOrchestratorGraph,
  listOrchestratorGraphs,
  deleteOrchestratorGraph,
} from '../../services/workflow-orchestrator/graph-storage';
import { createEmptyGraph } from '../../services/workflow-orchestrator/graph-schema';

const flowgramMocks = vi.hoisted(() => ({
  fromJSON: vi.fn(),
  selectNode: vi.fn(),
  createNode: vi.fn(),
}));

vi.mock('@flowgram.ai/free-layout-editor', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    EditorRenderer: () => <div data-testid="fwf-canvas-mock" />,
    FreeLayoutEditorProvider: ({
      children,
    }: {
      children: React.ReactNode;
    }) => <div>{children}</div>,
    useClientContext: () => ({
      document: {
        toJSON: () => ({ nodes: [], edges: [] }),
        fromJSON: flowgramMocks.fromJSON,
        createWorkflowNodeByType: flowgramMocks.createNode,
      },
      selection: {
        selection: [],
        selectNode: flowgramMocks.selectNode,
        onSelectionChanged: () => ({ dispose: () => {} }),
      },
    }),
    useService: () => ({ selectNode: flowgramMocks.selectNode }),
    WorkflowSelectService: class WorkflowSelectServiceMock {},
    getAntiOverlapPosition: () => ({ x: 0, y: 0 }),
    createFreeStackPlugin: () => ({}),
    useNodeRender: () => ({ ports: [], form: null }),
    PlaygroundEntityContext: actual.createContext(null),
  };
});
vi.mock('@flowgram.ai/free-lines-plugin', () => ({
  createFreeLinesPlugin: () => ({}),
}));
vi.mock('@flowgram.ai/minimap-plugin', () => ({
  createMinimapPlugin: () => ({}),
}));

beforeEach(async () => {
  window.history.replaceState(null, '', '/');
  for (const g of await listOrchestratorGraphs()) {
    await deleteOrchestratorGraph(g.id);
  }
});

describe('WorkflowEditorApp', () => {
  it('无 URL 参数时新建空图并渲染完整壳(顶栏/节点面板/画布/参数栏)', async () => {
    render(<WorkflowEditorApp />);
    await waitFor(() => {
      expect(screen.getByText('← 画布')).toBeTruthy();
    });
    expect(screen.getByTestId('fwf-canvas-mock')).toBeTruthy();
    // 左侧节点面板:8 种节点
    expect(screen.getByText('提示词')).toBeTruthy();
    expect(screen.getByText('存素材库')).toBeTruthy();
    // 右侧参数栏空态
    expect(screen.getByText('选中节点后在此编辑参数')).toBeTruthy();
  });

  it('点击节点面板项目调用 createWorkflowNodeByType', async () => {
    render(<WorkflowEditorApp />);
    await waitFor(() => {
      expect(screen.getByText('← 画布')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('参考图'));
    expect(flowgramMocks.createNode).toHaveBeenCalled();
  });

  it('手动保存:文档收集 → graph-storage 落盘', async () => {
    render(<WorkflowEditorApp />);
    await waitFor(() => {
      expect(screen.getByText('← 画布')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(async () => {
      const list = await listOrchestratorGraphs();
      expect(list.length).toBe(1);
    });
    const list = await listOrchestratorGraphs();
    expect(list[0].name).toBe('未命名工作流');
  });

  it('?graph= 指向不存在图时兜底新建', async () => {
    window.history.replaceState(null, '', '/workflow?graph=wfg_missing');
    render(<WorkflowEditorApp />);
    await waitFor(() => {
      expect(screen.getByText('← 画布')).toBeTruthy();
    });
    // 兜底新建后 URL 应换成本地图 id
    expect(window.location.search).not.toContain('wfg_missing');
  });

  it('?graph= 指向已存图时加载其内容', async () => {
    const graph = createEmptyGraph('存量图');
    graph.nodes.push({
      id: 'n1',
      type: 'prompt',
      params: { text: 'hi' },
      geometry: { x: 1, y: 2 },
    });
    await saveOrchestratorGraph(graph);
    window.history.replaceState(null, '', `/workflow?graph=${graph.id}`);
    render(<WorkflowEditorApp />);
    await waitFor(() => {
      // 顶栏名称输入框显示已加载图的名称
      expect(screen.getByDisplayValue('存量图')).toBeTruthy();
    });
    const loaded = await loadOrchestratorGraph(graph.id);
    expect(loaded?.name).toBe('存量图');
  });
});

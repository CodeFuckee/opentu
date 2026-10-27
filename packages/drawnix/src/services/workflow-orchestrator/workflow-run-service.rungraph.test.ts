/**
 * workflow-run-service.runGraph 单测(board-free 运行路径)。
 *
 * mock 执行引擎/工作流工厂/SW 能力通道/消息提示,验证:
 * 编译错误提示、无可执行节点、无画布时 insert_images 标 failed 且
 * 不阻断其余步骤、正常提交时步骤齐带 pending 状态。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { workflowRunService } from './workflow-run-service';
import { createEmptyGraph, type OrchestratorGraph } from './graph-schema';

const mocks = vi.hoisted(() => ({
  submitWorkflow: vi.fn().mockResolvedValue(undefined),
  cancelWorkflow: vi.fn(),
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
  messageWarning: vi.fn(),
}));

vi.mock('../workflow-engine/engine', () => ({
  WorkflowEngine: class {
    submitWorkflow = mocks.submitWorkflow;
    cancelWorkflow = mocks.cancelWorkflow;
  },
}));

vi.mock('../workflow-engine/workflow-factory', () => ({
  createWorkflow: (name: string, steps: unknown[]) => ({
    id: 'wf_test_1',
    name,
    steps,
  }),
}));

vi.mock('../sw-capabilities', () => ({
  swCapabilitiesHandler: { execute: vi.fn() },
  // 编辑器场景:永远无画布
  getCapabilitiesBoard: () => null,
}));

vi.mock('../../utils/message-plugin', () => ({
  MessagePlugin: {
    success: mocks.messageSuccess,
    error: mocks.messageError,
    warning: mocks.messageWarning,
  },
}));

function buildGraph(
  mutate: (g: OrchestratorGraph) => void
): OrchestratorGraph {
  const g = createEmptyGraph('编辑器图');
  mutate(g);
  return g;
}

beforeEach(() => {
  mocks.submitWorkflow.mockClear();
  mocks.messageError.mockClear();
  mocks.messageWarning.mockClear();
  workflowRunService.stop();
});

describe('runGraph(无画布上下文)', () => {
  it('编译失败(成环)提示错误且不提交', () => {
    const graph = buildGraph((g) => {
      g.nodes.push(
        { id: 'a', type: 'prompt', params: {}, geometry: { x: 0, y: 0 } },
        { id: 'b', type: 'image-generation', params: { prompt: 'x' }, geometry: { x: 1, y: 0 } }
      );
      g.edges.push(
        {
          id: 'e1',
          source: 'b',
          sourcePort: 'outputs:images',
          target: 'a',
          targetPort: 'inputs:prompt',
        },
        {
          id: 'e2',
          source: 'a',
          sourcePort: 'outputs:text',
          target: 'b',
          targetPort: 'inputs:prompt',
        }
      );
    });
    workflowRunService.runGraph(graph);
    expect(mocks.messageError).toHaveBeenCalled();
    expect(mocks.submitWorkflow).not.toHaveBeenCalled();
  });

  it('空图提示无可执行节点', () => {
    workflowRunService.runGraph(buildGraph(() => {}));
    expect(mocks.messageWarning).toHaveBeenCalledWith('工作流中没有可执行的节点');
    expect(mocks.submitWorkflow).not.toHaveBeenCalled();
  });

  it('无画布时插入画布步骤标 failed,不阻断其余步骤', () => {
    const graph = buildGraph((g) => {
      g.nodes.push(
        { id: 'p', type: 'prompt', params: { text: '猫' }, geometry: { x: 0, y: 0 } },
        { id: 'gen', type: 'image-generation', params: { prompt: '猫' }, geometry: { x: 1, y: 0 } },
        { id: 'ins', type: 'insert-canvas', params: {}, geometry: { x: 2, y: 0 } }
      );
      g.edges.push(
        {
          id: 'e1',
          source: 'p',
          sourcePort: 'outputs:text',
          target: 'gen',
          targetPort: 'inputs:prompt',
        },
        {
          id: 'e2',
          source: 'gen',
          sourcePort: 'outputs:images',
          target: 'ins',
          targetPort: 'inputs:images',
        }
      );
    });
    workflowRunService.runGraph(graph);
    const snapshot = workflowRunService.getSnapshot();
    expect(snapshot.statuses.ins).toBe('failed');
    expect(snapshot.errors.ins).toContain('回画布');
    // generate_image 步骤仍在提交中
    expect(mocks.submitWorkflow).toHaveBeenCalledTimes(1);
    const submitted = mocks.submitWorkflow.mock.calls[0][0] as {
      steps: Array<{ id: string }>;
    };
    expect(submitted.steps.map((s) => s.id)).toEqual(['gen']);
  });

  it('孤立插入画布节点被编译器拒绝', () => {
    const graph = buildGraph((g) => {
      g.nodes.push(
        { id: 'ins', type: 'insert-canvas', params: {}, geometry: { x: 0, y: 0 } }
      );
    });
    workflowRunService.runGraph(graph);
    expect(mocks.messageError).toHaveBeenCalled();
    expect(mocks.submitWorkflow).not.toHaveBeenCalled();
  });

  it('正常生图链路提交且步骤转 pending', () => {
    const graph = buildGraph((g) => {
      g.nodes.push(
        { id: 'p', type: 'prompt', params: { text: '猫' }, geometry: { x: 0, y: 0 } },
        { id: 'gen', type: 'image-generation', params: { prompt: '猫' }, geometry: { x: 1, y: 0 } },
        { id: 'lib', type: 'save-library', params: {}, geometry: { x: 2, y: 0 } }
      );
      g.edges.push(
        {
          id: 'e1',
          source: 'p',
          sourcePort: 'outputs:text',
          target: 'gen',
          targetPort: 'inputs:prompt',
        },
        {
          id: 'e2',
          source: 'gen',
          sourcePort: 'outputs:images',
          target: 'lib',
          targetPort: 'inputs:images',
        }
      );
    });
    workflowRunService.runGraph(graph);
    const snapshot = workflowRunService.getSnapshot();
    expect(snapshot.statuses.gen).toBe('pending');
    expect(snapshot.statuses.lib).toBe('pending');
    expect(mocks.submitWorkflow).toHaveBeenCalledTimes(1);
    const submitted = mocks.submitWorkflow.mock.calls[0][0] as {
      name: string;
      steps: Array<{ id: string; mcp: string }>;
    };
    expect(submitted.name).toBe('编辑器图');
    expect(submitted.steps.map((s) => [s.id, s.mcp])).toEqual([
      ['gen', 'generate_image'],
      ['lib', 'archive_media'],
    ]);
  });
});

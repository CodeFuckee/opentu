/**
 * Workflow Engine Tests
 * 主线程工作流引擎测试
 *
 * 测试场景：
 * 1. 工作流类型定义
 * 2. 工作流引擎基本功能
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveStepArgs } from '../workflow-engine/engine';
import type {
  Workflow,
  WorkflowStep,
  WorkflowEvent,
  WorkflowStatus,
  WorkflowStepStatus,
} from '../workflow-engine/types';

describe('WorkflowEngine Module', () => {
  describe('Workflow Types', () => {
    it('should define correct WorkflowStep structure', () => {
      const step: WorkflowStep = {
        id: 'step-1',
        mcp: 'generate_image',
        args: { prompt: 'A cat' },
        description: 'Generate a cat image',
        status: 'pending',
      };

      expect(step.id).toBe('step-1');
      expect(step.mcp).toBe('generate_image');
      expect(step.status).toBe('pending');
    });

    it('should support all step statuses', () => {
      const statuses: WorkflowStepStatus[] = [
        'pending',
        'running',
        'completed',
        'failed',
        'skipped',
      ];

      statuses.forEach((status) => {
        const step: WorkflowStep = {
          id: 'step-1',
          mcp: 'test',
          args: {},
          description: 'Test',
          status,
        };
        expect(step.status).toBe(status);
      });
    });

    it('should define correct Workflow structure', () => {
      const workflow: Workflow = {
        id: 'workflow-1',
        name: 'Test Workflow',
        steps: [
          {
            id: 'step-1',
            mcp: 'generate_image',
            args: { prompt: 'Test' },
            description: 'Test step',
            status: 'pending',
          },
        ],
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(workflow.id).toBe('workflow-1');
      expect(workflow.steps).toHaveLength(1);
      expect(workflow.status).toBe('pending');
    });

    it('should support all workflow statuses', () => {
      const statuses: WorkflowStatus[] = [
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled',
      ];

      statuses.forEach((status) => {
        const workflow: Workflow = {
          id: 'workflow-1',
          name: 'Test',
          steps: [],
          status,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        expect(workflow.status).toBe(status);
      });
    });

    it('should support optional workflow fields', () => {
      const workflow: Workflow = {
        id: 'workflow-1',
        name: 'Test',
        steps: [],
        status: 'completed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: Date.now(),
        error: 'Some error',
        context: { key: 'value' },
      };

      expect(workflow.completedAt).toBeDefined();
      expect(workflow.error).toBe('Some error');
      expect(workflow.context).toEqual({ key: 'value' });
    });
  });

  describe('WorkflowEvent Types', () => {
    it('should define status event', () => {
      const event: WorkflowEvent = {
        type: 'status',
        workflowId: 'workflow-1',
        status: 'running',
      };

      expect(event.type).toBe('status');
      expect(event.workflowId).toBe('workflow-1');
    });

    it('should define step event', () => {
      const event: WorkflowEvent = {
        type: 'step',
        workflowId: 'workflow-1',
        stepId: 'step-1',
        status: 'completed',
        result: { taskId: 'task-1' },
      };

      expect(event.type).toBe('step');
      expect(event.stepId).toBe('step-1');
    });

    it('should define completed event', () => {
      const workflow: Workflow = {
        id: 'workflow-1',
        name: 'Test',
        steps: [],
        status: 'completed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const event: WorkflowEvent = {
        type: 'completed',
        workflowId: 'workflow-1',
        workflow,
      };

      expect(event.type).toBe('completed');
      expect(event.workflow).toBeDefined();
    });

    it('should define failed event', () => {
      const event: WorkflowEvent = {
        type: 'failed',
        workflowId: 'workflow-1',
        error: 'Something went wrong',
      };

      expect(event.type).toBe('failed');
      expect(event.error).toBe('Something went wrong');
    });

    it('should define steps_added event', () => {
      const event: WorkflowEvent = {
        type: 'steps_added',
        workflowId: 'workflow-1',
        steps: [
          {
            id: 'step-2',
            mcp: 'generate_video',
            args: {},
            description: 'New step',
            status: 'pending',
          },
        ],
      };

      expect(event.type).toBe('steps_added');
      expect(event.steps).toHaveLength(1);
    });
  });

  describe('WorkflowEngine Class', () => {
    beforeEach(() => {
      vi.resetModules();
      // 整桶 mock 重型依赖：真实 media-executor/media-generation 在 jsdom 测试环境下
      // 模块顶层初始化会挂起（导致导入超时），此处统一替换为轻量实现。
      vi.doMock('../media-executor', () => ({
        executorFactory: {
          getExecutor: async () => ({
            name: 'Mock',
            isAvailable: async () => true,
            generateImage: async () => ({ url: 'mock' }),
            generateVideo: async () => ({ url: 'mock' }),
            aiAnalyze: async () => null,
            generateText: async () => ({ content: 'test' }),
          }),
        },
        taskStorageWriter: {
          getTasks: async () => [],
          saveTask: async () => {},
          deleteTask: async () => {},
          updateTaskStatus: async () => {},
          archiveTasks: async () => {},
        },
      }));
      vi.doMock('../media-generation', () => ({
        generateImage: async () => ({ url: 'mock' }),
        generateVideo: async () => ({ url: 'mock' }),
        TaskStatus: { COMPLETED: 'completed', FAILED: 'failed', RUNNING: 'running' },
      }));
    });

    it('should export WorkflowEngine class', async () => {
      vi.doMock('../media-executor/factory', () => ({
        executorFactory: {
          getExecutor: async () => ({
            name: 'Mock',
            isAvailable: async () => true,
            generateImage: async () => {},
            generateVideo: async () => {},
            aiAnalyze: async () => {},
            generateText: async () => ({ content: 'test' }),
          }),
        },
      }));

      vi.doMock('../workflow-engine/workflow-storage-writer', () => ({
        workflowStorageWriter: {
          isAvailable: async () => true,
          createWorkflow: async () => {},
          updateWorkflowStatus: async () => {},
          updateStepStatus: async () => {},
          completeWorkflow: async () => {},
          failWorkflow: async () => {},
        },
      }));

      vi.doMock('../media-executor/task-polling', () => ({
        waitForTaskCompletion: async () => ({
          success: true,
          task: { id: 'test', status: 'completed' },
        }),
      }));

      const { WorkflowEngine } = await import('../workflow-engine/engine');

      expect(WorkflowEngine).toBeDefined();
      expect(typeof WorkflowEngine).toBe('function');
    });

    it('should create engine with event handler', async () => {
      vi.doMock('../media-executor/factory', () => ({
        executorFactory: {
          getExecutor: async () => ({
            name: 'Mock',
            isAvailable: async () => true,
            generateImage: async () => {},
            generateVideo: async () => {},
            aiAnalyze: async () => {},
            generateText: async () => ({ content: 'test' }),
          }),
        },
      }));

      vi.doMock('../workflow-engine/workflow-storage-writer', () => ({
        workflowStorageWriter: {
          isAvailable: async () => true,
          createWorkflow: async () => {},
          updateWorkflowStatus: async () => {},
          updateStepStatus: async () => {},
          completeWorkflow: async () => {},
          failWorkflow: async () => {},
        },
      }));

      vi.doMock('../media-executor/task-polling', () => ({
        waitForTaskCompletion: async () => ({
          success: true,
          task: { id: 'test', status: 'completed' },
        }),
      }));

      const { WorkflowEngine } = await import('../workflow-engine/engine');

      const events: WorkflowEvent[] = [];
      const engine = new WorkflowEngine({
        onEvent: (event) => events.push(event),
      });

      expect(engine).toBeDefined();
    });

    it('should have submitWorkflow method', async () => {
      vi.doMock('../media-executor/factory', () => ({
        executorFactory: {
          getExecutor: async () => ({
            name: 'Mock',
            isAvailable: async () => true,
            generateImage: async () => {},
            generateVideo: async () => {},
            aiAnalyze: async () => {},
            generateText: async () => ({ content: 'test' }),
          }),
        },
      }));

      vi.doMock('../workflow-engine/workflow-storage-writer', () => ({
        workflowStorageWriter: {
          isAvailable: async () => true,
          createWorkflow: async () => {},
          updateWorkflowStatus: async () => {},
          updateStepStatus: async () => {},
          completeWorkflow: async () => {},
          failWorkflow: async () => {},
        },
      }));

      vi.doMock('../media-executor/task-polling', () => ({
        waitForTaskCompletion: async () => ({
          success: true,
          task: { id: 'test', status: 'completed' },
        }),
      }));

      const { WorkflowEngine } = await import('../workflow-engine/engine');
      const engine = new WorkflowEngine({ onEvent: () => {} });

      expect(typeof engine.submitWorkflow).toBe('function');
    });

    it('should have getWorkflow method', async () => {
      vi.doMock('../media-executor/factory', () => ({
        executorFactory: {
          getExecutor: async () => ({
            name: 'Mock',
            isAvailable: async () => true,
            generateImage: async () => {},
            generateVideo: async () => {},
            aiAnalyze: async () => {},
            generateText: async () => ({ content: 'test' }),
          }),
        },
      }));

      vi.doMock('../workflow-engine/workflow-storage-writer', () => ({
        workflowStorageWriter: {
          isAvailable: async () => true,
          createWorkflow: async () => {},
          updateWorkflowStatus: async () => {},
          updateStepStatus: async () => {},
          completeWorkflow: async () => {},
          failWorkflow: async () => {},
        },
      }));

      vi.doMock('../media-executor/task-polling', () => ({
        waitForTaskCompletion: async () => ({
          success: true,
          task: { id: 'test', status: 'completed' },
        }),
      }));

      const { WorkflowEngine } = await import('../workflow-engine/engine');
      const engine = new WorkflowEngine({ onEvent: () => {} });

      expect(typeof engine.getWorkflow).toBe('function');
    });

    it('should return undefined for non-existent workflow', async () => {
      vi.doMock('../media-executor/factory', () => ({
        executorFactory: {
          getExecutor: async () => ({
            name: 'Mock',
            isAvailable: async () => true,
            generateImage: async () => {},
            generateVideo: async () => {},
            aiAnalyze: async () => {},
            generateText: async () => ({ content: 'test' }),
          }),
        },
      }));

      vi.doMock('../workflow-engine/workflow-storage-writer', () => ({
        workflowStorageWriter: {
          isAvailable: async () => true,
          createWorkflow: async () => {},
          updateWorkflowStatus: async () => {},
          updateStepStatus: async () => {},
          completeWorkflow: async () => {},
          failWorkflow: async () => {},
        },
      }));

      vi.doMock('../media-executor/task-polling', () => ({
        waitForTaskCompletion: async () => ({
          success: true,
          task: { id: 'test', status: 'completed' },
        }),
      }));

      const { WorkflowEngine } = await import('../workflow-engine/engine');
      const engine = new WorkflowEngine({ onEvent: () => {} });

      const result = engine.getWorkflow('non-existent-id');
      expect(result).toBeUndefined();
    });
  });
});

// ============================================================================
// 编排器数据边:运行时占位符解析(resolveStepArgs)
// ============================================================================


describe('resolveStepArgs(编排器运行时占位符)', () => {
  const workflow = {
    steps: [
      {
        id: 'gen1',
        mcp: 'generate_image',
        args: {},
        description: '',
        status: 'completed' as const,
        result: { urls: ['http://a/1.png', 'http://a/2.png'], taskId: 't1' },
      },
    ],
  } as unknown as Workflow;

  it('整串 {{id.urls}} 占位符替换为上游数组', () => {
    const resolved = resolveStepArgs(
      { urls: '{{gen1.urls}}' },
      workflow
    );
    expect(resolved.urls).toEqual(['http://a/1.png', 'http://a/2.png']);
  });

  it('整串 {{id.url}} 缺失时回退语义由 {{id}} 简写承担', () => {
    const resolved = resolveStepArgs({ u: '{{gen1.url}}' }, workflow);
    // 上游无 url 字段 → 保留原样(由工具参数校验报错)
    expect(resolved.u).toBe('{{gen1.url}}');
    const primary = resolveStepArgs({ u: '{{gen1}}' }, workflow);
    // 简写取 urls[0]
    expect(primary.u).toBe('http://a/1.png');
  });

  it('嵌入式占位符做字符串插值', () => {
    const resolved = resolveStepArgs(
      { prompt: '风格A {{gen1.url}} 风格B' },
      { ...workflow, steps: [{ ...workflow.steps[0], result: { url: 'http://x/f.png' } }] } as unknown as Workflow
    );
    expect(resolved.prompt).toBe('风格A http://x/f.png 风格B');
  });

  it('深嵌套对象与数组内的占位符都解析', () => {
    const resolved = resolveStepArgs(
      { nested: { list: ['{{gen1.urls}}'], tag: '{{gen1.taskId}}' } },
      workflow
    );
    expect(resolved.nested.list).toEqual(['http://a/1.png', 'http://a/2.png']);
    expect(resolved.nested.tag).toBe('t1');
  });

  it('未知引用保留原样不抛错', () => {
    const resolved = resolveStepArgs(
      { u: '{{ghost.urls}}' },
      workflow
    );
    expect(resolved.u).toBe('{{ghost.urls}}');
  });
});

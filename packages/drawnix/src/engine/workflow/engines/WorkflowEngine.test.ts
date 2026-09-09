/**
 * 工作流执行引擎行为测试
 * 以假 AI 服务 + 假工具执行器驱动完整执行链路：
 * 终止、链式传递、参数映射、失败与超时、取消、迭代上限与事件流
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkflowEngine } from './WorkflowEngine';
import type {
  AIService,
  ToolExecutor,
  WorkflowEvent,
  WorkflowEventListener,
} from '../types/workflow.types';
import type { MCPTool, MCPToolResult } from '../../types/mcp.types';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 按脚本顺序回放的假 AI 服务（脚本耗尽后重复最后一条） */
const scriptedAI = (...responses: string[]): AIService & { chat: ReturnType<typeof vi.fn> } => {
  let i = 0;
  return {
    chat: vi.fn(() => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return Promise.resolve(r);
    }),
  };
};

/** 假工具执行器：记录调用并按表回放结果 */
const scriptedExecutor = (
  results: Record<string, MCPToolResult | ((args: Record<string, unknown>) => MCPToolResult)>
): ToolExecutor & { execute: ReturnType<typeof vi.fn> } => ({
  execute: vi.fn((toolName: string, args: Record<string, unknown>) => {
    const r = results[toolName];
    if (!r) throw new Error(`未注册的工具: ${toolName}`);
    return Promise.resolve(typeof r === 'function' ? r(args) : r);
  }),
});

const textResult = (text: string): MCPToolResult => ({
  content: [{ type: 'text', text }],
});

const callJson = (content: string, next: unknown[] = []): string =>
  JSON.stringify({ content, next });

/** 收集事件的监听器 */
const collector = (): { events: WorkflowEvent[]; listener: WorkflowEventListener } => {
  const events: WorkflowEvent[] = [];
  return { events, listener: (e) => events.push(e) };
};

describe('WorkflowEngine 基本执行与终止', () => {
  it('AI 直接返回 content（无 next）→ 成功终止，输出经 cleanFinalOutput 清理', async () => {
    const ai = scriptedAI(callJson('用户请求生成图片。图片已经准备好了。任务已完成，无需进一步操作。'));
    const executor = scriptedExecutor({});
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    const { events, listener } = collector();
    engine.addEventListener(listener);

    const result = await engine.execute('画一只猫');

    expect(result.success).toBe(true);
    // 后缀清理正则会连同前置标点一并移除
    expect(result.output).toBe('图片已经准备好了');
    expect(result.finalOutput).toBe(result.output);
    expect(result.iterations).toBe(1);
    expect(result.mcpCalls).toHaveLength(0);
    expect(result.terminationReason).toBe('任务完成');
    expect(executor.execute).not.toHaveBeenCalled();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('iteration_start');
    expect(types).toContain('iteration_started');
    expect(types).toContain('llm_response');
    expect(types[types.length - 1]).toBe('workflow_complete');
  });

  it('AI 返回 next 空数组同样视为终止', async () => {
    const ai = scriptedAI(callJson('done', []));
    const engine = new WorkflowEngine(ai, scriptedExecutor({}));
    const result = await engine.execute('任务');
    expect(result.success).toBe(true);
  });

  it('iteration_started 事件携带 system/user 提示词，setTools 影响系统提示词', async () => {
    const tool: MCPTool = {
      name: 'my_tool',
      description: '我的工具',
      inputSchema: { type: 'object' },
    };
    const ai = scriptedAI(callJson('done'));
    const engine = new WorkflowEngine(ai, scriptedExecutor({}), {}, []);
    engine.setTools([tool]);
    const { events, listener } = collector();
    engine.addEventListener(listener);
    await engine.execute('任务');

    const started = events.find((e) => e.type === 'iteration_started');
    expect(started && started.type === 'iteration_started').toBe(true);
    if (started && started.type === 'iteration_started' && started.prompt) {
      expect(started.prompt.system).toContain('my_tool');
      expect(started.prompt.user).toContain('任务');
    }
  });
});

describe('WorkflowEngine 链式调用与参数传递', () => {
  it('同一迭代内：前一个工具的输出自动注入下一个工具的 content 参数', async () => {
    const ai = scriptedAI(
      callJson('执行', [{ mcp: 'toolA', args: {} }, { mcp: 'toolB', args: {} }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      toolA: textResult('A 的输出'),
      toolB: textResult('B 完成'),
    });
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    const result = await engine.execute('任务');

    expect(result.success).toBe(true);
    expect(result.mcpCalls).toHaveLength(2);
    // 第二次调用（toolB）收到的 content 为 toolA 的输出
    expect(executor.execute).toHaveBeenCalledTimes(2);
    const secondArgs = executor.execute.mock.calls[1][1] as Record<string, unknown>;
    expect(secondArgs.content).toBe('A 的输出');
    expect(result.output).toBe('完成');
  });

  it('跨迭代时上一迭代的工具输出经用户提示词传回大模型（不自动注入工具参数）', async () => {
    const ai = scriptedAI(
      callJson('第一步', [{ mcp: 'toolA', args: {} }]),
      callJson('完成')
    );
    const engine = new WorkflowEngine(
      ai,
      scriptedExecutor({ toolA: textResult('A 的输出') }),
      { maxIterations: 5 }
    );
    await engine.execute('任务');

    expect(ai.chat).toHaveBeenCalledTimes(2);
    const secondMessages = ai.chat.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(secondMessages[1].content).toContain('## 上一步输出');
    expect(secondMessages[1].content).toContain('A 的输出');
  });

  it('同一迭代内：目标参数已有 content 时不覆盖', async () => {
    const ai = scriptedAI(
      callJson('执行', [{ mcp: 'toolA', args: {} }, { mcp: 'toolB', args: { content: '预设' } }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      toolA: textResult('A 的输出'),
      toolB: textResult('ok'),
    });
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    await engine.execute('任务');

    const secondArgs = executor.execute.mock.calls[1][1] as Record<string, unknown>;
    expect(secondArgs.content).toBe('预设');
  });

  it('同一迭代内：目标参数只有 input 时注入 content 且保留 input', async () => {
    const ai = scriptedAI(
      callJson('执行', [{ mcp: 'toolA', args: {} }, { mcp: 'toolB', args: { input: '已有输入' } }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      toolA: textResult('A 的输出'),
      toolB: textResult('ok'),
    });
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    await engine.execute('任务');

    const secondArgs = executor.execute.mock.calls[1][1] as Record<string, unknown>;
    expect(secondArgs.input).toBe('已有输入');
    expect(secondArgs.content).toBe('A 的输出');
  });

  it('同一迭代内：关闭参数映射时直接注入上一工具输出', async () => {
    const ai = scriptedAI(
      callJson('执行', [{ mcp: 'toolA', args: {} }, { mcp: 'toolB', args: {} }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      toolA: textResult('A 的输出'),
      toolB: textResult('ok'),
    });
    const engine = new WorkflowEngine(ai, executor, {
      maxIterations: 5,
      enableParameterMapping: false,
    });
    await engine.execute('任务');

    const secondArgs = executor.execute.mock.calls[1][1] as Record<string, unknown>;
    expect(secondArgs.content).toBe('A 的输出');
  });

  it('同一迭代内：关闭参数映射且已有 content 时不覆盖', async () => {
    const ai = scriptedAI(
      callJson('执行', [{ mcp: 'toolA', args: {} }, { mcp: 'toolB', args: { content: '预设' } }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      toolA: textResult('A 的输出'),
      toolB: textResult('ok'),
    });
    const engine = new WorkflowEngine(ai, executor, {
      maxIterations: 5,
      enableParameterMapping: false,
    });
    await engine.execute('任务');

    const secondArgs = executor.execute.mock.calls[1][1] as Record<string, unknown>;
    expect(secondArgs.content).toBe('预设');
  });

  it('同一迭代内：参数映射整体失败时回退为 content 注入', async () => {
    const ai = scriptedAI(
      callJson('执行', [{ mcp: 'toolA', args: {} }, { mcp: 'toolB', args: {} }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      toolA: textResult('A 的输出'),
      toolB: textResult('ok'),
    });
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    // required 规则映射失败 → map() 整体失败 → 回退注入
    engine.registerParameterMapping('toolA', 'toolB', [
      { source: 'gone', target: 'must', type: 'string', required: true },
    ]);
    await engine.execute('任务');

    const secondArgs = executor.execute.mock.calls[1][1] as Record<string, unknown>;
    expect(secondArgs.content).toBe('A 的输出');
  });

  it('工具执行完成后触发 cancel() 时中断后续调用并按用户取消终止', async () => {
    const ai = scriptedAI(
      callJson('执行', [{ mcp: 'toolA', args: {} }, { mcp: 'toolB', args: {} }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      toolA: textResult('A 的输出'),
      toolB: textResult('B 完成'),
    });
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    const { events, listener } = collector();
    engine.addEventListener(listener);
    // toolA 结果返回后触发取消，toolB 不再执行
    engine.addEventListener((e) => {
      if (e.type === 'mcp_call_complete') engine.cancel();
    });
    const result = await engine.execute('任务');

    expect(result.success).toBe(false);
    expect(result.terminationReason).toBe('用户取消');
    expect(result.finalOutput).toBe('A 的输出');
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(events[events.length - 1].type).toBe('workflow_complete');
  });

  it('迭代次数逼近上限时发出 guard_warning，随后强制终止', async () => {
    const ai = scriptedAI(callJson('继续', [{ mcp: 'loop_tool', args: {} }]));
    const executor = scriptedExecutor({ loop_tool: textResult('x') });
    const engine = new WorkflowEngine(ai, executor, {
      maxIterations: 4,
      warningThreshold: 2,
      enableLoopDetection: false,
    });
    const { events, listener } = collector();
    engine.addEventListener(listener);
    const result = await engine.execute('任务');

    expect(events.some((e) => e.type === 'guard_warning')).toBe(true);
    expect(events.some((e) => e.type === 'force_terminate')).toBe(true);
    expect(result.success).toBe(false);
  });

  it('同一迭代内：注册参数映射规则后按规则提取（而非整串注入）', async () => {
    const ai = scriptedAI(
      callJson('执行', [{ mcp: 'toolA', args: {} }, { mcp: 'toolB', args: { keep: 1 } }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      // toolA 输出 JSON 字符串，供参数映射解析
      toolA: textResult(JSON.stringify({ text: '提取值' })),
      toolB: textResult('ok'),
    });
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    engine.registerParameterMapping('toolA', 'toolB', [
      { source: 'text', target: 'content', type: 'string' },
    ]);
    await engine.execute('任务');

    const secondArgs = executor.execute.mock.calls[1][1] as Record<string, unknown>;
    expect(secondArgs.keep).toBe(1);
    expect(secondArgs.content).toBe('提取值');
  });

  it('同一迭代内：预置映射（ai_generate->show_result）无需注册即可生效', async () => {
    const ai = scriptedAI(
      callJson('执行', [{ mcp: 'ai_generate', args: {} }, { mcp: 'show_result', args: {} }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      ai_generate: textResult(JSON.stringify({ url: 'http://x' })),
      show_result: textResult('shown'),
    });
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    await engine.execute('任务');

    const secondArgs = executor.execute.mock.calls[1][1] as Record<string, unknown>;
    // GENERIC_TO_CONTENT：$ + toString → 整个 JSON 序列化进 content
    expect(secondArgs.content).toBe(JSON.stringify({ url: 'http://x' }));
  });

  it('registerParameterMappings 批量注册 / getParameterMapper 暴露映射器', () => {
    const engine = new WorkflowEngine(scriptedAI(callJson('done')), scriptedExecutor({}));
    engine.registerParameterMappings({ 'a->b': [{ source: '$', target: 'x' }] });
    expect(engine.getParameterMapper().getMapping('a', 'b')).toHaveLength(1);
  });
});

describe('WorkflowEngine 失败 / 超时 / 异常', () => {
  it('工具执行失败不中断工作流，错误文本作为下一步输出继续', async () => {
    const ai = scriptedAI(
      callJson('第一步', [{ mcp: 'bad_tool', args: {} }]),
      callJson('收到错误，结束')
    );
    const executor = scriptedExecutor({});
    executor.execute.mockImplementationOnce(() =>
      Promise.reject(new Error('工具内部错误'))
    );
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    const result = await engine.execute('任务');

    expect(result.success).toBe(true);
    expect(result.mcpCalls[0].success).toBe(false);
    expect(result.mcpCalls[0].error).toBe('工具内部错误');
  });

  it('工具执行超时按配置时长判定失败', async () => {
    const ai = scriptedAI(
      callJson('第一步', [{ mcp: 'slow_tool', args: {} }]),
      callJson('超时结束')
    );
    const executor: ToolExecutor = {
      execute: () => new Promise<MCPToolResult>(() => {}),
    };
    const engine = new WorkflowEngine(ai, executor, {
      maxIterations: 5,
      toolTimeout: 60,
    });
    const result = await engine.execute('任务');

    expect(result.mcpCalls[0].success).toBe(false);
    expect(result.mcpCalls[0].error).toBe('工具执行超时');
  }, 5000);

  it('AI 服务异常 → workflow_error 事件 + 失败结果', async () => {
    const ai: AIService = {
      chat: vi.fn(() => Promise.reject(new Error('网络崩溃'))),
    };
    const engine = new WorkflowEngine(ai, scriptedExecutor({}));
    const { events, listener } = collector();
    engine.addEventListener(listener);
    const result = await engine.execute('任务');

    expect(result.success).toBe(false);
    expect(result.error).toBe('网络崩溃');
    expect(result.terminationReason).toBe('执行错误: 网络崩溃');
    expect(events.some((e) => e.type === 'workflow_error')).toBe(true);
  });

  it('工具返回多段 text 内容时以换行拼接', async () => {
    const ai = scriptedAI(
      callJson('第一步', [{ mcp: 'multi', args: {} }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      multi: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    });
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    const result = await engine.execute('任务');
    expect(result.mcpCalls[0].result).toBe('a\nb');
  });

  it('工具返回空内容 / 仅非文本内容时结果为空字符串', async () => {
    const ai = scriptedAI(
      callJson('第一步', [{ mcp: 'empty', args: {} }, { mcp: 'image_only', args: {} }]),
      callJson('完成')
    );
    const executor = scriptedExecutor({
      empty: { content: [] },
      image_only: { content: [{ type: 'image', data: 'base64' }] },
    });
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 5 });
    const result = await engine.execute('任务');
    expect(result.mcpCalls[0].result).toBe('');
    expect(result.mcpCalls[1].result).toBe('');
  });
});

describe('WorkflowEngine 防护与取消', () => {
  it('达到最大迭代次数后强制终止，返回失败结果', async () => {
    // AI 永远要求调用同一个工具，关闭循环检测以专注迭代上限
    const ai = scriptedAI(callJson('继续', [{ mcp: 'loop_tool', args: {} }]));
    const executor = scriptedExecutor({ loop_tool: textResult('x') });
    const engine = new WorkflowEngine(ai, executor, {
      maxIterations: 3,
      enableLoopDetection: false,
    });
    const result = await engine.execute('任务');

    expect(result.success).toBe(false);
    expect(result.terminationReason).toBeTruthy();
    expect(result.mcpCalls.length).toBeGreaterThanOrEqual(2);
    expect(result.mcpCalls.length).toBeLessThanOrEqual(3);
  });

  it('重复相同工具调用触发 loop_detected 事件', async () => {
    const ai = scriptedAI(callJson('继续', [{ mcp: 'same_tool', args: {} }]));
    const executor = scriptedExecutor({ same_tool: textResult('x') });
    const engine = new WorkflowEngine(ai, executor, { maxIterations: 8 });
    const { events, listener } = collector();
    engine.addEventListener(listener);
    await engine.execute('任务');

    expect(events.some((e) => e.type === 'loop_detected')).toBe(true);
  });

  it('cancel() 中断等待中的 AI 调用并通知 stopGeneration', async () => {
    let releaseChat!: (v: string) => void;
    const ai: AIService & { stopGeneration: ReturnType<typeof vi.fn> } = {
      chat: () => new Promise<string>((resolve) => { releaseChat = resolve; }),
      stopGeneration: vi.fn(() => true),
    };
    const engine = new WorkflowEngine(ai, scriptedExecutor({}), { maxIterations: 5 });
    const promise = engine.execute('任务');
    // chat 已被同步调用并挂起
    await new Promise((r) => setTimeout(r, 0));
    engine.cancel();
    expect(ai.stopGeneration).toHaveBeenCalledWith(
      expect.stringContaining('iter1')
    );
    releaseChat(callJson('late'));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.terminationReason).toBe('用户取消');
  });

  it('cancel() 后 AI 调用才失败时按用户取消终止（不再向上抛错）', async () => {
    let rejectChat!: (e: Error) => void;
    const ai: AIService = {
      chat: () => new Promise<string>((_, reject) => { rejectChat = reject; }),
    };
    const engine = new WorkflowEngine(ai, scriptedExecutor({}), { maxIterations: 5 });
    const promise = engine.execute('任务');
    await new Promise((r) => setTimeout(r, 0));
    engine.cancel();
    rejectChat(new Error('取消后的迟到失败'));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.terminationReason).toBe('用户取消');
    expect(result.error).toBe('用户取消');
  });

  it('getExecutionSummary 返回防护摘要字符串', async () => {
    const engine = new WorkflowEngine(scriptedAI(callJson('done')), scriptedExecutor({}));
    await engine.execute('任务');
    expect(typeof engine.getExecutionSummary()).toBe('string');
  });
});

describe('WorkflowEngine 事件订阅', () => {
  it('事件序列覆盖一次完整的工具调用迭代', async () => {
    const ai = scriptedAI(
      callJson('第一步', [{ mcp: 'toolA', args: {} }]),
      callJson('完成')
    );
    const engine = new WorkflowEngine(
      ai,
      scriptedExecutor({ toolA: textResult('out') }),
      { maxIterations: 5 }
    );
    const { events, listener } = collector();
    engine.addEventListener(listener);
    await engine.execute('任务');

    const types = events.map((e) => e.type);
    expect(types).toContain('mcp_call_start');
    expect(types).toContain('mcp_call');
    expect(types).toContain('mcp_call_complete');
    expect(types).toContain('iteration_completed');
    expect(types[types.length - 1]).toBe('workflow_complete');
    // AI 被调用两次（迭代 1 调工具、迭代 2 终止）
    expect(types.filter((t) => t === 'llm_response')).toHaveLength(2);
  });

  it('监听器抛异常不影响执行（被 emit 吞掉）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ai = scriptedAI(callJson('done'));
    const engine = new WorkflowEngine(ai, scriptedExecutor({}));
    engine.addEventListener(() => {
      throw new Error('监听器崩溃');
    });
    const result = await engine.execute('任务');
    expect(result.success).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('Event listener error:', expect.any(Error));
  });

  it('addEventListener 返回退订函数，退订后不再收到事件', async () => {
    const ai = scriptedAI(callJson('done'));
    const engine = new WorkflowEngine(ai, scriptedExecutor({}));
    const { events, listener } = collector();
    const off = engine.addEventListener(listener);
    off();
    await engine.execute('任务');
    expect(events).toHaveLength(0);
  });
});

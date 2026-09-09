/**
 * 参数跟踪器行为测试
 * 跟踪器的方法以内部状态记录为主（控制台输出已注释），
 * 此处锁定其生命周期调用在启用/禁用两种状态下均安全无副作用抛错。
 */
import { describe, it, expect } from 'vitest';
import { ParameterTracer, parameterTracer } from './ParameterTracer';
import type { MappingRule } from './types';

describe('ParameterTracer 生命周期', () => {
  it('启用状态下完整走一遍跟踪流程不抛错', () => {
    const tracer = new ParameterTracer();
    const rule = { source: '$', target: 'content' } as MappingRule;
    expect(() => {
      tracer.setLogLevel('debug');
      tracer.startTrace('toolA', 'toolB');
      tracer.logStep('step-1', { k: 1 });
      tracer.logRuleApplication(rule, 'src', 'dst');
      tracer.logWarning('w');
      tracer.logError('e');
      tracer.logSummary('toolA', 'toolB', { content: 'x' });
      tracer.endTrace({ params: { content: 'x' }, warnings: [], success: true });
    }).not.toThrow();
  });

  it('禁用状态下所有调用为 no-op，同样不抛错', () => {
    const tracer = new ParameterTracer();
    tracer.setEnabled(false);
    const rule = { source: '$', target: 'content' } as MappingRule;
    expect(() => {
      tracer.startTrace('toolA', 'toolB');
      tracer.logStep('step-1');
      tracer.logRuleApplication(rule, 'src', 'dst');
      tracer.logWarning('w');
      tracer.logError('e');
      tracer.logSummary('toolA', 'toolB', {});
      tracer.endTrace({ params: {}, warnings: [], success: false });
    }).not.toThrow();
  });

  it('导出单例可用', () => {
    expect(parameterTracer).toBeInstanceOf(ParameterTracer);
  });
});

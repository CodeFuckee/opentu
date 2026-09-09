/**
 * Guards 再导出兼容性测试
 * WorkflowGuard / RecursionGuard / LoopDetector 从 @aitu/utils 再导出，
 * 保持 engine 内旧的导入路径向后兼容
 */
import { describe, it, expect } from 'vitest';
import { WorkflowGuard } from './workflow-guard';
import { RecursionGuard } from './recursion-guard';
import { LoopDetector } from './loop-detector';

describe('guards 再导出模块', () => {
  it('三个守卫类均以类形式再导出（可实例化）', () => {
    expect(typeof WorkflowGuard).toBe('function');
    expect(typeof RecursionGuard).toBe('function');
    expect(typeof LoopDetector).toBe('function');
  });
});

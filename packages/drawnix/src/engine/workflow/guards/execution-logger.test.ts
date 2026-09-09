/**
 * 执行日志记录器行为测试
 * 锁定级别过滤、开关、按步骤检索、清空与导出格式
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionLogger } from './execution-logger';

describe('ExecutionLogger 级别过滤与记录', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('默认 minLevel=info：debug 不记录，info 及以上记录', () => {
    const logger = new ExecutionLogger();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    const logs = logger.getLogs();
    expect(logs.map((l) => l.level)).toEqual(['info', 'warn', 'error']);
  });

  it('setMinLevel=debug 后 debug 也记录', () => {
    const logger = new ExecutionLogger();
    logger.setMinLevel('debug');
    logger.debug('d');
    expect(logger.getLogs()).toHaveLength(1);
    expect(logger.getLogs()[0].message).toBe('d');
  });

  it('记录条目包含 data 与 stepId', () => {
    const logger = new ExecutionLogger();
    logger.info('msg', { k: 1 }, 'step-1');
    const entry = logger.getLogs()[0];
    expect(entry.data).toEqual({ k: 1 });
    expect(entry.stepId).toBe('step-1');
    expect(typeof entry.timestamp).toBe('number');
  });

  it('setEnabled(false) 后完全静默', () => {
    const logger = new ExecutionLogger();
    logger.setEnabled(false);
    logger.error('e');
    expect(logger.getLogs()).toHaveLength(0);
  });

  it('warn / error 输出到控制台，info / debug 不输出', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new ExecutionLogger();
    logger.info('i');
    logger.warn('w', { a: 1 }, 's1');
    logger.error('e');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[Workflow][s1] w');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ExecutionLogger 检索 / 清空 / 导出', () => {
  it('getLogsByStep 只返回对应步骤的日志', () => {
    const logger = new ExecutionLogger();
    logger.info('a', undefined, 's1');
    logger.info('b', undefined, 's2');
    logger.warn('c', undefined, 's1');
    const s1 = logger.getLogsByStep('s1');
    expect(s1.map((l) => l.message)).toEqual(['a', 'c']);
    expect(logger.getLogsByStep('nope')).toEqual([]);
  });

  it('clear 清空全部日志', () => {
    const logger = new ExecutionLogger();
    logger.info('a');
    logger.clear();
    expect(logger.getLogs()).toEqual([]);
  });

  it('exportLogs 输出 ISO 时间 + 大写级别 + 可选步骤与数据', () => {
    const logger = new ExecutionLogger();
    logger.setMinLevel('debug');
    logger.debug('plain');
    logger.info('with-data', { k: 1 }, 'step-9');
    const exported = logger.exportLogs();
    const lines = exported.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.* \[DEBUG\] plain$/);
    expect(lines[1]).toContain('[INFO][step-9] with-data | {"k":1}');
  });

  it('getLogs 返回副本，外部修改不影响内部状态', () => {
    const logger = new ExecutionLogger();
    logger.info('a');
    const copy = logger.getLogs();
    copy.push({ timestamp: 0, level: 'error', message: 'inject' });
    expect(logger.getLogs()).toHaveLength(1);
  });
});

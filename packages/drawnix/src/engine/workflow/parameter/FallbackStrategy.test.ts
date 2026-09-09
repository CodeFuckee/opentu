/**
 * 回退策略行为测试
 * 锁定四种策略的降级决策与 executeAuto 自动选择
 */
import { describe, it, expect } from 'vitest';
import { FallbackStrategy } from './FallbackStrategy';
import { DEFAULT_FALLBACK_CONFIG, EMPTY_VALUES } from './types';
import type { MappingRule } from './types';

const rule = (extra: Partial<MappingRule> = {}): MappingRule => ({
  source: 'a.b',
  target: 't',
  ...extra,
});

describe('FallbackStrategy.execute - 显式策略', () => {
  it('useDefault：有 defaultValue 用之，否则按类型空值，兜底 undefined', () => {
    const s = new FallbackStrategy();
    const withDefault = s.execute(undefined, rule({ defaultValue: 'D' }), 'err');
    expect(withDefault).toMatchObject({
      value: 'D',
      shouldSkip: false,
      shouldAbort: false,
      strategyUsed: 'useDefault',
    });

    const withType = s.execute(undefined, rule({ type: 'string' }), 'err');
    expect(withType.value).toBe('');

    const bare = s.execute(undefined, rule(), 'err');
    expect(bare.value).toBeUndefined();
  });

  it('skipParameter：跳过参数不中止', () => {
    const s = new FallbackStrategy();
    const r = s.execute({ strategy: 'skipParameter', logLevel: 'warn' }, rule(), 'err');
    expect(r).toMatchObject({
      value: undefined,
      shouldSkip: true,
      shouldAbort: false,
      strategyUsed: 'skipParameter',
    });
  });

  it('abortStep：中止当前步骤', () => {
    const s = new FallbackStrategy();
    const r = s.execute({ strategy: 'abortStep', logLevel: 'error' }, rule(), 'err');
    expect(r).toMatchObject({ shouldAbort: true, shouldSkip: false, strategyUsed: 'abortStep' });
  });

  it('useEmpty：按规则类型（缺省 any）取空值', () => {
    const s = new FallbackStrategy();
    const withType = s.execute({ strategy: 'useEmpty', logLevel: 'debug' }, rule({ type: 'array' }), 'err');
    expect(withType.value).toEqual([]);
    expect(withType.shouldAbort).toBe(false);

    const noType = s.execute({ strategy: 'useEmpty', logLevel: 'debug' }, rule(), 'err');
    expect(noType.value).toBe(EMPTY_VALUES.any);
  });

  it('未知策略回退为 useDefault', () => {
    const s = new FallbackStrategy();
    const r = s.execute(
      { strategy: 'unknown' as never, logLevel: 'warn' },
      rule({ defaultValue: 'D' }),
      'err'
    );
    expect(r.strategyUsed).toBe('useDefault');
    expect(r.value).toBe('D');
  });

  it('默认策略为 DEFAULT_FALLBACK_CONFIG.useDefault', () => {
    const s = new FallbackStrategy();
    const r = s.execute(undefined, rule({ defaultValue: 'D' }), 'err');
    expect(r.strategyUsed).toBe(DEFAULT_FALLBACK_CONFIG.strategy);
  });

  it('自定义 errorMessage 覆盖默认日志文案；默认文案包含 target 与错误', () => {
    const s = new FallbackStrategy();
    const custom = s.execute(
      { strategy: 'skipParameter', logLevel: 'warn', errorMessage: '自定义失败原因' },
      rule({ target: 'myTarget' }),
      'boom'
    );
    expect(custom.logMessage).toContain('自定义失败原因');

    const fallback = s.execute(undefined, rule({ target: 'myTarget' }), 'boom');
    expect(fallback.logMessage).toContain('myTarget');
    expect(fallback.logMessage).toContain('boom');
  });

  it('setDefaultConfig 持久生效于未显式传配置的调用', () => {
    const s = new FallbackStrategy();
    s.setDefaultConfig({ strategy: 'abortStep' });
    const r = s.execute(undefined, rule(), 'err');
    expect(r.shouldAbort).toBe(true);
    // 日志级别等其余字段保留默认
    expect(DEFAULT_FALLBACK_CONFIG.logLevel).toBe('warn');
  });
});

describe('FallbackStrategy.executeAuto - 自动决策', () => {
  const s = new FallbackStrategy();

  it('required 且无 defaultValue → abortStep', () => {
    const r = s.executeAuto(rule({ required: true }), 'missing');
    expect(r.strategyUsed).toBe('abortStep');
    expect(r.shouldAbort).toBe(true);
  });

  it('有 defaultValue（无论是否 required）→ useDefault', () => {
    const r1 = s.executeAuto(rule({ defaultValue: 'D' }), 'missing');
    expect(r1.strategyUsed).toBe('useDefault');
    expect(r1.value).toBe('D');

    const r2 = s.executeAuto(rule({ required: true, defaultValue: 'D' }), 'missing');
    expect(r2.strategyUsed).toBe('useDefault');
    expect(r2.shouldAbort).toBe(false);
  });

  it('普通可选参数 → useEmpty（按类型）', () => {
    const r = s.executeAuto(rule({ type: 'object' }), 'missing');
    expect(r.strategyUsed).toBe('useEmpty');
    expect(r.value).toEqual({});
  });
});

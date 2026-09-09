/**
 * 默认值处理器行为测试
 * 锁定默认值/类型空值的选择、深拷贝隔离与批量应用
 */
import { describe, it, expect } from 'vitest';
import { DefaultValueHandler } from './DefaultValueHandler';
import type { MappingRule } from './types';

describe('DefaultValueHandler.getDefault / getEmptyValue', () => {
  const handler = new DefaultValueHandler();

  it('优先使用规则自带的 defaultValue', () => {
    const rule = { source: 'a', target: 'b', type: 'string', defaultValue: 'D' } as MappingRule;
    expect(handler.getDefault(rule)).toBe('D');
  });

  it('无 defaultValue 时按类型取空值', () => {
    const rule = { source: 'a', target: 'b', type: 'number' } as MappingRule;
    expect(handler.getDefault(rule)).toBe(0);
  });

  it('两者都没有返回 undefined', () => {
    const rule = { source: 'a', target: 'b' } as MappingRule;
    expect(handler.getDefault(rule)).toBeUndefined();
  });

  it('defaultValue 为对象时深拷贝，两次结果互不共享引用', () => {
    const rule = { source: 'a', target: 'b', defaultValue: { list: [1, { x: 1 }] } } as MappingRule;
    const first = handler.getDefault(rule) as { list: unknown[] };
    const second = handler.getDefault(rule) as { list: unknown[] };
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.list).not.toBe(second.list);
    (first.list[1] as { x: number }).x = 99;
    expect((second.list[1] as { x: number }).x).toBe(1);
  });

  it('getEmptyValue 每次返回新的容器实例', () => {
    const a = handler.getEmptyValue('array') as unknown[];
    const b = handler.getEmptyValue('array') as unknown[];
    expect(a).toEqual([]);
    expect(a).not.toBe(b);
    expect(handler.getEmptyValue('object')).toEqual({});
    expect(handler.getEmptyValue('string')).toBe('');
    expect(handler.getEmptyValue('boolean')).toBe(false);
    expect(handler.getEmptyValue('any')).toBeUndefined();
  });
});

describe('DefaultValueHandler.needsDefault', () => {
  const handler = new DefaultValueHandler();

  it('undefined / null 需要默认值', () => {
    const rule = { source: 'a', target: 'b' } as MappingRule;
    expect(handler.needsDefault(undefined, rule)).toBe(true);
    expect(handler.needsDefault(null, rule)).toBe(true);
  });

  it('空白字符串仅在规则有 defaultValue 时才需要默认值', () => {
    const withDefault = { source: 'a', target: 'b', defaultValue: 'D' } as MappingRule;
    const withoutDefault = { source: 'a', target: 'b' } as MappingRule;
    expect(handler.needsDefault('   ', withDefault)).toBe(true);
    expect(handler.needsDefault('', withoutDefault)).toBe(false);
  });

  it('其他值（含 0 / false / 空数组）不需要默认值', () => {
    const rule = { source: 'a', target: 'b', defaultValue: 'D' } as MappingRule;
    expect(handler.needsDefault(0, rule)).toBe(false);
    expect(handler.needsDefault(false, rule)).toBe(false);
    expect(handler.needsDefault([], rule)).toBe(false);
  });
});

describe('DefaultValueHandler.applyDefault / applyDefaults', () => {
  const handler = new DefaultValueHandler();

  it('applyDefault 按需填充，已有正常值原样返回', () => {
    const rule = { source: 'a', target: 'b', defaultValue: 'D' } as MappingRule;
    expect(handler.applyDefault(undefined, rule)).toBe('D');
    expect(handler.applyDefault('  ', rule)).toBe('D');
    expect(handler.applyDefault('real', rule)).toBe('real');
  });

  it('applyDefaults 批量填充并保留未涉及的键', () => {
    const rules: MappingRule[] = [
      { source: 'a', target: 'keep', defaultValue: 'X' },
      { source: 'b', target: 'fill', defaultValue: 'D' },
      { source: 'c', target: 'missing', type: 'number' },
    ];
    const result = handler.applyDefaults({ keep: 'v', fill: '' }, rules);
    expect(result).toEqual({ keep: 'v', fill: 'D', missing: 0 });
  });

  it('applyDefaults 不修改入参对象', () => {
    const rules: MappingRule[] = [{ source: 'a', target: 't', defaultValue: 'D' }];
    const input = { t: undefined };
    handler.applyDefaults(input, rules);
    expect(input).toEqual({ t: undefined });
  });
});

/**
 * 参数映射器行为测试
 * 锁定映射注册、规则应用顺序、类型校验/转换、回退与默认 content 行为
 */
import { describe, it, expect } from 'vitest';
import { ParameterMapper } from './ParameterMapper';
import type { MappingRule } from './types';

/** 纯净实例：注册表互不影响 */
const fresh = () => new ParameterMapper({ enableTracing: false });

describe('ParameterMapper 注册表管理', () => {
  it('registerMapping / getMapping / hasMapping / getAllMappings / clearMappings', () => {
    const m = fresh();
    const rules: MappingRule[] = [{ source: '$', target: 'content' }];
    expect(m.hasMapping('a', 'b')).toBe(false);
    m.registerMapping('a', 'b', rules);
    expect(m.getMapping('a', 'b')).toBe(rules);
    expect(m.hasMapping('a', 'b')).toBe(true);
    expect(m.getMapping('a', 'c')).toBeUndefined();
    expect(m.getAllMappings()).toEqual({ 'a->b': rules });
    m.clearMappings();
    expect(m.getAllMappings()).toEqual({});
  });

  it('registerMappings 批量注册', () => {
    const m = fresh();
    m.registerMappings({ 'a->b': [{ source: '$', target: 'x' }], 'c->d': [] });
    expect(m.hasMapping('a', 'b')).toBe(true);
    expect(m.getMapping('c', 'd')).toEqual([]);
  });
});

describe('ParameterMapper.map - 无规则时的默认行为', () => {
  it('无规则且 sourceOutput 非空：对象 JSON 序列化进 content', () => {
    const m = fresh();
    const r = m.map('a', 'b', { k: 1 });
    expect(r.success).toBe(true);
    expect(r.params.content).toBe('{"k":1}');
  });

  it('无规则且 sourceOutput 为字符串：原样进 content', () => {
    const m = fresh();
    expect(m.map('a', 'b', 'raw text').params.content).toBe('raw text');
  });

  it('已有 content 参数时不覆盖', () => {
    const m = fresh();
    const r = m.map('a', 'b', 'new', { content: 'kept' });
    expect(r.params.content).toBe('kept');
  });

  it('sourceOutput 为 null/undefined 时不注入 content', () => {
    const m = fresh();
    expect(m.map('a', 'b', null).params).toEqual({});
    expect(m.map('a', 'b', undefined).params).toEqual({});
  });
});

describe('ParameterMapper.map - 纯字符串与 JSON 字符串输入', () => {
  it('非 JSON 字符串直接映射为 content', () => {
    const m = fresh();
    const r = m.map('a', 'b', 'plain', {});
    expect(r.success).toBe(true);
    expect(r.params.content).toBe('plain');
  });

  it('非 JSON 字符串且已有 content 时直接返回不覆盖', () => {
    const m = fresh();
    const r = m.map('a', 'b', 'plain', { content: 'kept' });
    expect(r.success).toBe(true);
    expect(r.params.content).toBe('kept');
  });

  it('JSON 字符串先解析再走规则提取', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [{ source: 'data.value', target: 'out' }]);
    const r = m.map('a', 'b', '{"data":{"value":"V"}}');
    expect(r.params.out).toBe('V');
  });

  it('已注册规则但输入为纯字符串时直接映射为 content', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [{ source: 'data.value', target: 'out' }]);
    const r = m.map('a', 'b', 'plain text');
    expect(r.success).toBe(true);
    expect(r.params.content).toBe('plain text');
  });

  it('已注册规则、输入为纯字符串且已有 content 时保留原值', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [{ source: 'data.value', target: 'out' }]);
    const r = m.map('a', 'b', 'plain text', { content: 'kept' });
    expect(r.params.content).toBe('kept');
  });
});

describe('ParameterMapper.map - 规则应用', () => {
  it('路径提取 + 类型转换（transform）', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [
      { source: 'result.items', target: 'count', transform: 'length' },
    ]);
    const r = m.map('a', 'b', { result: { items: [1, 2, 3] } });
    expect(r.params.count).toBe(3);
    expect(r.success).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('多条规则时首条产出有效值后即停止（不继续应用后续规则）', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [
      { source: 'v1', target: 'out' },
      { source: 'v2', target: 'out2' },
    ]);
    const r = m.map('a', 'b', { v1: 1, v2: 2 });
    expect(r.params.out).toBe(1);
    expect(r.params.out2).toBeUndefined();
  });

  it('规则路径未命中且无类型/默认值时产出 undefined，继续尝试下一条规则', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [
      { source: 'nope', target: 'x' },
      { source: 'yes', target: 'x' },
    ]);
    const r = m.map('a', 'b', { yes: 'Y' });
    expect(r.params.x).toBe('Y');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].message).toContain('x');
  });

  it('类型不匹配且开启类型强转时自动转换（string ← number）', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [{ source: 'n', target: 's', type: 'string' }]);
    const r = m.map('a', 'b', { n: 42 });
    expect(r.params.s).toBe('42');
  });

  it('类型不匹配且无法强转时走 executeAuto：有 defaultValue 用默认值', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [
      { source: 'n', target: 'num', type: 'number', defaultValue: 9 },
    ]);
    // 对象 → number 无法 coerce（返回 undefined）→ 回退 useDefault
    const r = m.map('a', 'b', { n: { x: 1 } });
    expect(r.params.num).toBe(9);
    expect(r.warnings[0].fallbackUsed).toBe('useDefault');
  });

  it('required 规则映射失败时整体失败并给出错误', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [
      { source: 'gone', target: 'must', type: 'string', required: true },
    ]);
    const r = m.map('a', 'b', { other: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('must');
    expect(r.warnings[0].fallbackUsed).toBe('abortStep');
  });

  it('关闭类型强转（enableTypeCoercion: false）时类型不匹配直接走回退', () => {
    const m = new ParameterMapper({ enableTracing: false, enableTypeCoercion: false });
    m.registerMapping('a', 'b', [
      { source: 'n', target: 's', type: 'string', defaultValue: 'D' },
    ]);
    const r = m.map('a', 'b', { n: 42 });
    expect(r.params.s).toBe('D');
  });

  it('空值填充默认值（defaultValue 处理空白字符串）', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [
      { source: 's', target: 't', defaultValue: 'D' },
    ]);
    const r = m.map('a', 'b', { s: '   ' });
    expect(r.params.t).toBe('D');
  });

  it('全部规则未命中时兜底把整个 source 写入 content', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [{ source: 'nope', target: 'x', defaultValue: 'D' }]);
    const r = m.map('a', 'b', { keep: 1 });
    // 第一条规则未命中 → useDefault 产出 'D' 并 break；content 兜底仍然注入
    expect(r.params.x).toBe('D');
    expect(r.params.content).toBe('{"keep":1}');
  });

  it('existingArgs 中的其他参数被保留', () => {
    const m = fresh();
    m.registerMapping('a', 'b', [{ source: 'v', target: 'x' }]);
    const r = m.map('a', 'b', { v: 1 }, { preset: 'P' });
    expect(r.params.preset).toBe('P');
    expect(r.params.x).toBe(1);
  });
});

describe('ParameterMapper.applyTransform 内置转换', () => {
  const m = fresh();
  // 注意：map() 对纯字符串输入会短路为 content 注入，
  // 因此包装为对象并从 v 路径取值，确保规则与 transform 生效
  const mapWith = (transform: string, value: unknown) => {
    m.clearMappings();
    m.registerMapping('s', 't', [{ source: 'v', target: 'out', transform }]);
    return m.map('s', 't', { v: value }).params.out;
  };

  it('toString：对象 JSON 化，原始值 String 化', () => {
    expect(mapWith('toString', { a: 1 })).toBe('{"a":1}');
    expect(mapWith('toString', 5)).toBe('5');
  });

  it('toNumber / toBoolean', () => {
    expect(mapWith('toNumber', '12')).toBe(12);
    expect(mapWith('toBoolean', 1)).toBe(true);
  });

  it('toArray / toJSON', () => {
    expect(mapWith('toArray', 1)).toEqual([1]);
    expect(mapWith('toArray', [1])).toEqual([1]);
    expect(mapWith('toJSON', '{"a":1}')).toEqual({ a: 1 });
    expect(mapWith('toJSON', { a: 1 })).toEqual({ a: 1 });
  });

  it('trim / lowercase / uppercase', () => {
    expect(mapWith('trim', '  x  ')).toBe('x');
    expect(mapWith('lowercase', 'ABC')).toBe('abc');
    expect(mapWith('uppercase', 'abc')).toBe('ABC');
    // 非字符串原样返回
    expect(mapWith('trim', 5)).toBe(5);
  });

  it('first / last / length / keys / values', () => {
    expect(mapWith('first', [1, 2])).toBe(1);
    expect(mapWith('first', 5)).toBe(5);
    expect(mapWith('last', [1, 2])).toBe(2);
    expect(mapWith('length', [1, 2, 3])).toBe(3);
    expect(mapWith('length', 'abcd')).toBe(4);
    expect(mapWith('length', { a: 1, b: 2 })).toBe(2);
    expect(mapWith('length', 5)).toBe(0);
    expect(mapWith('keys', { a: 1 })).toEqual(['a']);
    expect(mapWith('keys', 5)).toEqual([]);
    expect(mapWith('values', { a: 1 })).toEqual([1]);
    expect(mapWith('values', 5)).toEqual([]);
  });

  it('未知 transform 原样返回', () => {
    expect(mapWith('noSuchTransform', 'x')).toBe('x');
  });
});

describe('ParameterMapper 配置项', () => {
  it('defaultFallback 配置当前不影响规则回退（回退决策始终由 executeAuto 决定）', () => {
    // 已知行为：applyRule 失败路径固定走 executeAuto，
    // 构造器的 defaultFallback 仅写入全局策略、不会被规则回退读取
    const m = new ParameterMapper({
      enableTracing: false,
      defaultFallback: { strategy: 'abortStep' },
    });
    m.registerMapping('a', 'b', [{ source: 'gone', target: 'x' }]);
    const r = m.map('a', 'b', { v: 1 });
    // 非必需参数未命中 → useEmpty(any)=undefined → 跳过规则 → content 兜底，整体成功
    expect(r.success).toBe(true);
    expect(r.params.content).toBe('{"v":1}');
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('setLogLevel / setTracingEnabled 可调用且不抛错', () => {
    const m = fresh();
    expect(() => {
      m.setLogLevel('debug');
      m.setTracingEnabled(true);
      m.setTracingEnabled(false);
    }).not.toThrow();
  });
});

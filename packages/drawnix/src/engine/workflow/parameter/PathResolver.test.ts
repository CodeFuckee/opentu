/**
 * 路径解析器行为测试
 * 锁定点分隔路径 / 数组索引（含负索引）/ 引号键 的解析、读取与写入行为
 */
import { describe, it, expect } from 'vitest';
import { PathResolver } from './PathResolver';

describe('PathResolver.resolve - 路径读取', () => {
  const resolver = new PathResolver();
  const source = {
    name: 'root',
    result: { items: [{ href: 'a' }, { href: 'b' }] },
    'key-with-dash': { inner: 1 },
    "key.with.dot": 2,
  };

  it('空路径 / "." 返回整个 source', () => {
    expect(resolver.resolve(source, '')).toEqual({
      success: true,
      value: source,
      resolvedPath: [],
    });
    expect(resolver.resolve(source, '.').value).toBe(source);
  });

  it('"$" 返回整个 source，resolvedPath 为 ["$"]', () => {
    const r = resolver.resolve(source, '$');
    expect(r.success).toBe(true);
    expect(r.value).toBe(source);
    expect(r.resolvedPath).toEqual(['$']);
  });

  it('点分隔属性链', () => {
    const r = resolver.resolve(source, 'result.items');
    expect(r.success).toBe(true);
    expect(r.value).toEqual([{ href: 'a' }, { href: 'b' }]);
    expect(r.resolvedPath).toEqual(['result', 'items']);
  });

  it('数组正索引与负索引', () => {
    expect(resolver.resolve(source, 'result.items[0].href').value).toBe('a');
    expect(resolver.resolve(source, 'result.items[-1].href').value).toBe('b');
  });

  it('引号键支持特殊字符属性名', () => {
    expect(resolver.resolve(source, '["key-with-dash"].inner').value).toBe(1);
    expect(resolver.resolve(source, "['key-with-dash'].inner").value).toBe(1);
  });

  it('访问 null/undefined 的属性返回失败', () => {
    const r = resolver.resolve({ a: null }, 'a.b');
    expect(r.success).toBe(false);
    expect(r.error).toContain('Cannot access "b"');
    expect(r.resolvedPath).toEqual(['a']);
  });

  it('对非数组值使用索引返回失败', () => {
    const r = resolver.resolve({ a: 'str' }, 'a[0]');
    expect(r.success).toBe(false);
    expect(r.error).toContain('non-array');
  });

  it('数组索引越界返回失败（含负索引换算后越界）', () => {
    const r1 = resolver.resolve({ a: [1] }, 'a[5]');
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('out of bounds');
    const r2 = resolver.resolve({ a: [1] }, 'a[-2]');
    expect(r2.success).toBe(false);
  });

  it('访问不存在的属性返回失败', () => {
    const r = resolver.resolve(source, 'result.missing');
    expect(r.success).toBe(false);
    expect(r.error).toContain('does not exist');
  });

  it('对原始类型访问属性返回失败', () => {
    const r = resolver.resolve({ a: 42 }, 'a.x');
    expect(r.success).toBe(false);
    expect(r.error).toContain('on number');
  });

  it('无法解析出任何段落的路径返回失败', () => {
    // 全部是正则不认识的字符
    const r = resolver.resolve(source, '[][]');
    expect(r.success).toBe(false);
    expect(r.error).toContain('Invalid path');
  });
});

describe('PathResolver.set - 路径写入', () => {
  const resolver = new PathResolver();

  it('写入已存在的简单属性', () => {
    const target: Record<string, unknown> = { a: 1 };
    expect(resolver.set(target, 'a', 2)).toBe(true);
    expect(target.a).toBe(2);
  });

  it('自动创建中间对象', () => {
    const target: Record<string, unknown> = {};
    expect(resolver.set(target, 'a.b.c', 1)).toBe(true);
    expect(target).toEqual({ a: { b: { c: 1 } } });
  });

  it('按下一个段类型自动创建数组或对象', () => {
    const target: Record<string, unknown> = {};
    resolver.set(target, 'list[0]', 'x');
    expect(target.list).toEqual(['x']);
    resolver.set(target, 'obj.nested.v', 1);
    expect(target.obj).toEqual({ nested: { v: 1 } });
  });

  it('负索引写入已有数组的末元素', () => {
    const target = { items: [1, 2] };
    expect(resolver.set(target, 'items[-1]', 3)).toBe(true);
    expect(target.items).toEqual([1, 3]);
  });

  it('空数组负索引换算后仍为负返回失败', () => {
    const target = { items: [] as unknown[] };
    expect(resolver.set(target, 'items[-1]', 3)).toBe(false);
    expect(target.items).toEqual([]);
  });

  it('负索引用于中间段且换算后为负返回失败', () => {
    const target = { items: [] as unknown[] };
    expect(resolver.set(target, 'items[-1].x', 3)).toBe(false);
    expect(target).toEqual({ items: [] });
  });

  it('路径无法解析出段落时返回 false', () => {
    const target: Record<string, unknown> = {};
    expect(resolver.set(target, '[][]', 1)).toBe(false);
    expect(target).toEqual({});
  });

  it('中间段为索引但当前不是数组返回失败', () => {
    const target: Record<string, unknown> = { a: 'str' };
    expect(resolver.set(target, 'a[0].b', 1)).toBe(false);
  });

  it('最后一段为索引但当前不是数组返回失败', () => {
    const target: Record<string, unknown> = { a: 'str' };
    expect(resolver.set(target, 'a[0]', 1)).toBe(false);
  });

  it('空路径返回 false 且不修改目标', () => {
    const target: Record<string, unknown> = {};
    expect(resolver.set(target, '', 1)).toBe(false);
    expect(resolver.set(target, '.', 1)).toBe(false);
    expect(target).toEqual({});
  });

  it('深层数组元素写入（中间数组元素不存在时留空洞后写入）', () => {
    const target: Record<string, unknown> = {};
    expect(resolver.set(target, 'a.b[1].c', 'v')).toBe(true);
    // 跳过下标 0 直接写 1：下标 0 为稀疏空洞（读取时表现为 undefined）
    expect(target).toEqual({ a: { b: [undefined, { c: 'v' }] } });
  });
});

describe('PathResolver 辅助方法', () => {
  const resolver = new PathResolver();

  it('exists 判断路径是否存在', () => {
    expect(resolver.exists({ a: { b: 1 } }, 'a.b')).toBe(true);
    expect(resolver.exists({ a: { b: 1 } }, 'a.c')).toBe(false);
  });

  it('get 命中返回值，未命中返回默认值', () => {
    expect(resolver.get({ a: { b: 1 } }, 'a.b', 'def')).toBe(1);
    expect(resolver.get({ a: {} }, 'a.b', 'def')).toBe('def');
  });
});

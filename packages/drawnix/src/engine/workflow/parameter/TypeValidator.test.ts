/**
 * 类型校验器行为测试
 * 锁定类型判定、校验、宽松类型转换与空值判定
 */
import { describe, it, expect } from 'vitest';
import { TypeValidator } from './TypeValidator';

describe('TypeValidator.getType', () => {
  const tv = new TypeValidator();

  it('基础类型判定', () => {
    expect(tv.getType(null)).toBe('null');
    expect(tv.getType(undefined)).toBe('undefined');
    expect(tv.getType([1])).toBe('array');
    expect(tv.getType('s')).toBe('string');
    expect(tv.getType(1)).toBe('number');
    expect(tv.getType(true)).toBe('boolean');
    expect(tv.getType({})).toBe('object');
  });
});

describe('TypeValidator.validate', () => {
  const tv = new TypeValidator();

  it('any 永远有效（含 null/undefined）', () => {
    expect(tv.validate(null, 'any').valid).toBe(true);
    expect(tv.validate(undefined, 'any').valid).toBe(true);
    expect(tv.validate(0, 'any').valid).toBe(true);
  });

  it('null / undefined 对具体类型一律无效', () => {
    for (const t of ['string', 'number', 'boolean', 'array', 'object'] as const) {
      expect(tv.validate(null, t).valid).toBe(false);
      expect(tv.validate(undefined, t).valid).toBe(false);
    }
  });

  it('string / number / boolean 校验', () => {
    expect(tv.validate('s', 'string').valid).toBe(true);
    expect(tv.validate(1, 'string').valid).toBe(false);
    expect(tv.validate(1, 'number').valid).toBe(true);
    expect(tv.validate(NaN, 'number').valid).toBe(false);
    expect(tv.validate(true, 'boolean').valid).toBe(true);
    expect(tv.validate(0, 'boolean').valid).toBe(false);
  });

  it('array / object 校验（数组不是 object）', () => {
    expect(tv.validate([], 'array').valid).toBe(true);
    expect(tv.validate({}, 'array').valid).toBe(false);
    expect(tv.validate({}, 'object').valid).toBe(true);
    expect(tv.validate([], 'object').valid).toBe(false);
  });

  it('失败时带错误信息与实际类型', () => {
    const r = tv.validate(1, 'string');
    expect(r.valid).toBe(false);
    expect(r.actualType).toBe('number');
    expect(r.expectedType).toBe('string');
    expect(r.error).toContain('Expected string, got number');
  });

  it('未知期望类型一律无效（switch default 分支）', () => {
    expect(tv.validate('s', 'unknown' as never).valid).toBe(false);
  });
});

describe('TypeValidator.coerce - 类型转换', () => {
  const tv = new TypeValidator();

  it('null / undefined 转换为 undefined', () => {
    expect(tv.coerce(null, 'string')).toBeUndefined();
    expect(tv.coerce(undefined, 'number')).toBeUndefined();
  });

  it('已符合目标类型时原样返回', () => {
    const arr = [1];
    expect(tv.coerce(arr, 'array')).toBe(arr);
    expect(tv.coerce('s', 'string')).toBe('s');
  });

  it('转 string：对象走 JSON 序列化', () => {
    expect(tv.coerce(5, 'string')).toBe('5');
    expect(tv.coerce(true, 'string')).toBe('true');
    expect(tv.coerce({ a: 1 }, 'string')).toBe('{"a":1}');
    expect(tv.coerce([1], 'string')).toBe('[1]');
  });

  it('转 number：数字字符串可转，非数字字符串 undefined，boolean 映射 1/0', () => {
    expect(tv.coerce('12.5', 'number')).toBe(12.5);
    expect(tv.coerce('abc', 'number')).toBeUndefined();
    expect(tv.coerce(true, 'number')).toBe(1);
    expect(tv.coerce(false, 'number')).toBe(0);
    expect(tv.coerce({}, 'number')).toBeUndefined();
  });

  it('转 boolean：true/1/yes 与 false/0/no（大小写不敏感），数字非 0 即真', () => {
    expect(tv.coerce('TRUE', 'boolean')).toBe(true);
    expect(tv.coerce('1', 'boolean')).toBe(true);
    expect(tv.coerce('yes', 'boolean')).toBe(true);
    expect(tv.coerce('False', 'boolean')).toBe(false);
    expect(tv.coerce('0', 'boolean')).toBe(false);
    expect(tv.coerce('NO', 'boolean')).toBe(false);
    expect(tv.coerce('maybe', 'boolean')).toBeUndefined();
    expect(tv.coerce(2, 'boolean')).toBe(true);
    expect(tv.coerce(0, 'boolean')).toBe(false);
    expect(tv.coerce([], 'boolean')).toBeUndefined();
  });

  it('转 array：JSON 数组字符串解析，非数组 JSON 或非法 JSON 包裹为单元素数组', () => {
    expect(tv.coerce('[1,2]', 'array')).toEqual([1, 2]);
    expect(tv.coerce('not json', 'array')).toEqual(['not json']);
    expect(tv.coerce(5, 'array')).toEqual([5]);
  });

  it('转 object：JSON 对象字符串解析，数组或非法输入 undefined', () => {
    expect(tv.coerce('{"a":1}', 'object')).toEqual({ a: 1 });
    expect(tv.coerce('[1]', 'object')).toBeUndefined();
    expect(tv.coerce('garbage', 'object')).toBeUndefined();
    expect(tv.coerce(1, 'object')).toBeUndefined();
  });

  it('转 any 原样返回', () => {
    const obj = { a: 1 };
    expect(tv.coerce(obj, 'any')).toBe(obj);
  });

  it('未知目标类型返回 undefined（switch default 分支）', () => {
    expect(tv.coerce('x', 'unknown' as never)).toBeUndefined();
  });
});

describe('TypeValidator.isEmpty / validateAll', () => {
  const tv = new TypeValidator();

  it('isEmpty 各类型空值判定', () => {
    expect(tv.isEmpty(null)).toBe(true);
    expect(tv.isEmpty(undefined)).toBe(true);
    expect(tv.isEmpty('  ')).toBe(true);
    expect(tv.isEmpty('')).toBe(true);
    expect(tv.isEmpty([])).toBe(true);
    expect(tv.isEmpty({})).toBe(true);
    expect(tv.isEmpty('x')).toBe(false);
    expect(tv.isEmpty([1])).toBe(false);
    expect(tv.isEmpty({ a: 1 })).toBe(false);
    expect(tv.isEmpty(0)).toBe(false);
    expect(tv.isEmpty(false)).toBe(false);
  });

  it('validateAll 批量校验并携带 name', () => {
    const results = tv.validateAll([
      { value: 's', type: 'string', name: 'a' },
      { value: 1, type: 'string', name: 'b' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ valid: true, name: 'a' });
    expect(results[1]).toMatchObject({ valid: false, name: 'b' });
  });
});

/**
 * checksum 纯函数测试
 */
import { describe, it, expect } from 'vitest';
import { calculateChecksum, entityKey, parseEntityKey } from './checksum';

describe('calculateChecksum', () => {
  it('空字符串返回确定值', () => {
    expect(calculateChecksum('')).toBe(calculateChecksum(''));
    expect(typeof calculateChecksum('')).toBe('string');
  });

  it('相同内容校验和一致', () => {
    const content = JSON.stringify({ a: 1, b: [1, 2, 3] });
    expect(calculateChecksum(content)).toBe(calculateChecksum(content));
  });

  it('不同内容校验和不同', () => {
    expect(calculateChecksum('hello')).not.toBe(calculateChecksum('hello!'));
  });

  it('超长内容不抛错', () => {
    const long = 'x'.repeat(10_000_000);
    expect(() => calculateChecksum(long)).not.toThrow();
    expect(typeof calculateChecksum(long)).toBe('string');
  });

  it('中文与 emoji 内容可计算', () => {
    const chinese = JSON.stringify({ 画板: '测试', emoji: '🎨🎬' });
    expect(typeof calculateChecksum(chinese)).toBe('string');
  });
});

describe('entityKey / parseEntityKey', () => {
  it('拼接与解析可逆', () => {
    const key = entityKey('board', 'board-123');
    expect(key).toBe('board:board-123');
    expect(parseEntityKey(key)).toEqual({ entityType: 'board', entityId: 'board-123' });
  });

  it('entity_id 含冒号仍可解析（取第一个分隔符）', () => {
    const key = entityKey('task', 'a:b:c');
    expect(parseEntityKey(key)).toEqual({ entityType: 'task', entityId: 'a:b:c' });
  });

  it('非法 key 返回 null', () => {
    expect(parseEntityKey('no-separator')).toBeNull();
    expect(parseEntityKey('')).toBeNull();
  });
});
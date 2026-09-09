/**
 * 工具响应辅助器行为测试
 * 锁定成功/错误响应构造、文本提取、错误判定与响应合并
 */
import { describe, it, expect } from 'vitest';
import { ToolResponseHelper } from './tool-response-helper';
import type { MCPToolResult } from '../types/mcp.types';

describe('ToolResponseHelper.success', () => {
  it('字符串包装为单个 text 内容项', () => {
    const r = ToolResponseHelper.success('hello');
    expect(r.isError).toBe(false);
    expect(r.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('内容数组原样使用（同一引用）', () => {
    const items = [{ type: 'text' as const, text: 'a' }];
    const r = ToolResponseHelper.success(items);
    expect(r.content).toBe(items);
    expect(r.isError).toBe(false);
  });
});

describe('ToolResponseHelper.error / isError', () => {
  it('错误响应带 isError 标记与文本', () => {
    const r = ToolResponseHelper.error('boom');
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: 'boom' }]);
  });

  it('isError：仅显式 true 为错误，缺省为否', () => {
    expect(ToolResponseHelper.isError({ content: [], isError: true })).toBe(true);
    expect(ToolResponseHelper.isError({ content: [] })).toBe(false);
    expect(ToolResponseHelper.isError({ content: [], isError: false })).toBe(false);
  });
});

describe('ToolResponseHelper.extractText', () => {
  it('多个 text 内容以换行拼接，非 text 项被过滤', () => {
    const r: MCPToolResult = {
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'xxx' },
        { type: 'text', text: 'b' },
      ],
    };
    expect(ToolResponseHelper.extractText(r)).toBe('a\nb');
  });

  it('无 content（字段缺失）返回空字符串', () => {
    expect(ToolResponseHelper.extractText({ content: [] })).toBe('');
    expect(
      ToolResponseHelper.extractText({
        content: undefined as unknown as MCPToolResult['content'],
      })
    ).toBe('');
  });
});

describe('ToolResponseHelper.merge', () => {
  it('合并全部内容并保持顺序，任一错误则整体错误', () => {
    const merged = ToolResponseHelper.merge([
      ToolResponseHelper.success('a'),
      ToolResponseHelper.error('bad'),
      ToolResponseHelper.success('c'),
    ]);
    expect(merged.content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'bad' },
      { type: 'text', text: 'c' },
    ]);
    expect(merged.isError).toBe(true);
  });

  it('全部成功时合并结果不为错误', () => {
    const merged = ToolResponseHelper.merge([
      ToolResponseHelper.success('a'),
      ToolResponseHelper.success('b'),
    ]);
    expect(merged.isError).toBe(false);
  });

  it('空数组合并为空内容且无错误', () => {
    expect(ToolResponseHelper.merge([])).toEqual({ content: [], isError: false });
  });

  it('content 缺失的结果不贡献内容但错误标记仍生效', () => {
    const merged = ToolResponseHelper.merge([
      { content: [{ type: 'text', text: 'x' }] },
      { content: undefined as unknown as MCPToolResult['content'], isError: true },
    ]);
    expect(merged.content).toEqual([{ type: 'text', text: 'x' }]);
    expect(merged.isError).toBe(true);
  });
});

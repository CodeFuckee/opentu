/**
 * 响应增强器行为测试
 * 锁定内容提取（非 text 过滤、换行拼接）与元数据生成
 */
import { describe, it, expect } from 'vitest';
import { ResponseEnhancer } from './response-enhancer';
import type { MCPToolResult } from '../types/mcp.types';

describe('ResponseEnhancer.enhance', () => {
  const enhancer = new ResponseEnhancer();

  it('提取全部 text 内容并以换行拼接，非 text 内容过滤', () => {
    const result: MCPToolResult = {
      content: [
        { type: 'text', text: '第一段' },
        { type: 'image', data: 'base64...' },
        { type: 'text', text: '第二段' },
      ],
    };
    const enhanced = enhancer.enhance('my_tool', result);
    expect(enhanced.enhanced).toBe('第一段\n第二段');
    expect(enhanced.original).toBe(result);
  });

  it('空 content / content 缺失字段时 enhanced 为空字符串', () => {
    expect(enhancer.enhance('t', { content: [] }).enhanced).toBe('');
    expect(
      enhancer.enhance('t', { content: undefined as unknown as MCPToolResult['content'] })
        .enhanced
    ).toBe('');
  });

  it('元数据包含工具 ID、时间戳与 contextAdded=false', () => {
    const before = Date.now();
    const enhanced = enhancer.enhance('my_tool', {
      content: [{ type: 'text', text: 'x' }],
    });
    expect(enhanced.metadata.toolId).toBe('my_tool');
    expect(enhanced.metadata.contextAdded).toBe(false);
    expect(enhanced.metadata.timestamp).toBeGreaterThanOrEqual(before);
    expect(enhanced.metadata.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('formatForDisplay 直接返回 enhanced 文本', () => {
    const enhanced = enhancer.enhance('t', { content: [{ type: 'text', text: 'x' }] });
    expect(enhancer.formatForDisplay(enhanced)).toBe('x');
  });
});

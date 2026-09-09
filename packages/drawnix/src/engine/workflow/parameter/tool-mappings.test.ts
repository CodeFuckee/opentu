/**
 * 默认工具映射配置行为测试
 * 锁定预置映射表、查询辅助函数与合并/构造工具
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOOL_MAPPINGS,
  COMMON_MAPPINGS,
  getToolMapping,
  hasToolMapping,
  getRegisteredToolPairs,
  createMappingRule,
  createContentMapping,
  mergeToolMappings,
} from './tool-mappings';

describe('DEFAULT_TOOL_MAPPINGS 预置映射', () => {
  it('注册了三组常用工具对', () => {
    expect(Object.keys(DEFAULT_TOOL_MAPPINGS).sort()).toEqual([
      'ai_generate->show_result',
      'fetch->show_result',
      'format_markdown->show_result',
    ]);
  });

  it('各映射规则的 source/target 指向明确', () => {
    expect(DEFAULT_TOOL_MAPPINGS['ai_generate->show_result']).toEqual([
      { source: '$', target: 'content', type: 'any', transform: 'toString' },
    ]);
    expect(DEFAULT_TOOL_MAPPINGS['format_markdown->show_result'][0]).toMatchObject({
      source: 'result',
      target: 'content',
      type: 'string',
    });
  });

  it('COMMON_MAPPINGS 暴露全部通用规则模板', () => {
    expect(Object.keys(COMMON_MAPPINGS).sort()).toEqual([
      'CONTENT_PASSTHROUGH',
      'GENERIC_TO_CONTENT',
      'GENERIC_TO_PROMPT',
      'GENERIC_TO_TEXT',
      'RESULT_TO_CONTENT',
      'TEXT_TO_CONTENT',
    ]);
  });
});

describe('工具映射查询辅助函数', () => {
  it('getToolMapping / hasToolMapping 按 source->target 查询', () => {
    expect(hasToolMapping('fetch', 'show_result')).toBe(true);
    expect(hasToolMapping('fetch', 'other')).toBe(false);
    expect(getToolMapping('fetch', 'show_result')).toEqual(
      DEFAULT_TOOL_MAPPINGS['fetch->show_result']
    );
    expect(getToolMapping('nope', 'nope')).toBeUndefined();
  });

  it('getRegisteredToolPairs 列出全部注册键', () => {
    expect(getRegisteredToolPairs()).toEqual(Object.keys(DEFAULT_TOOL_MAPPINGS));
  });
});

describe('映射规则构造工具', () => {
  it('createMappingRule 合并附加选项', () => {
    expect(
      createMappingRule('a.b', 'x', { type: 'string', required: true, defaultValue: 'D' })
    ).toEqual({ source: 'a.b', target: 'x', type: 'string', required: true, defaultValue: 'D' });
  });

  it('createContentMapping 自定义目标参数名（默认 content）', () => {
    expect(createContentMapping()).toEqual([
      { source: '$', target: 'content', type: 'any', transform: 'toString' },
    ]);
    expect(createContentMapping('prompt')).toEqual([
      { source: '$', target: 'prompt', type: 'any', transform: 'toString' },
    ]);
  });

  it('mergeToolMappings：新键合并、同键规则追加且不改入参', () => {
    const a = { 'x->y': [{ source: '$', target: 'c1' }] };
    const b = { 'x->y': [{ source: '$', target: 'c2' }], 'p->q': [{ source: '$', target: 'c3' }] };
    const merged = mergeToolMappings(a, b);
    expect(merged['x->y']).toEqual([
      { source: '$', target: 'c1' },
      { source: '$', target: 'c2' },
    ]);
    expect(merged['p->q']).toEqual([{ source: '$', target: 'c3' }]);
    // 不修改入参
    expect(a['x->y']).toHaveLength(1);
  });

  it('mergeToolMappings 空入参返回空对象', () => {
    expect(mergeToolMappings()).toEqual({});
  });
});

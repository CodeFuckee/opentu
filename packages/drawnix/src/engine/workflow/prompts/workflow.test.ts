/**
 * 工作流 Prompt/解析模块行为测试
 * 锁定 LLM 响应解析容错、终止判定、输出清理、图片过滤与提示词构建
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  filterMarkdownImages,
  getWorkflowSystemPrompt,
  getWorkflowUserPrompt,
  parseWorkflowResponse,
  parseWorkflowResponseDetailed,
  shouldTerminate,
  checkTermination,
  cleanFinalOutput,
} from './workflow';
import type { MCPTool } from '../types/mcp.types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseWorkflowResponse - JSON 提取与容错', () => {
  it('裸 JSON 直接解析', () => {
    const r = parseWorkflowResponse('{"content":"你好","next":[]}');
    expect(r.content).toBe('你好');
    expect(r.next).toBeUndefined();
  });

  it('```json 代码块优先于裸大括号', () => {
    const text = '前言 {"content":"错误的裸JSON"} ```json\n{"content":"块内"}\n```';
    const r = parseWorkflowResponse(text);
    expect(r.content).toBe('块内');
  });

  it('从混合文本中截取第一个 { 到最后一个 }', () => {
    const r = parseWorkflowResponse('分析如下：{"content":"结论"} 以上。');
    expect(r.content).toBe('结论');
  });

  it('无 JSON 时整段文本作为 content', () => {
    expect(parseWorkflowResponse('这是一段纯文本').content).toBe('这是一段纯文本');
    expect(parseWorkflowResponse('  带空白  ').content).toBe('带空白');
  });

  it('大括号内非法 JSON 时降级为原始文本', () => {
    const raw = '{invalid}';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseWorkflowResponse(raw);
    expect(r.content).toBe(raw);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('缺少 content 字段时降级为原始文本', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = '{"next":[]}';
    expect(parseWorkflowResponse(raw).content).toBe(raw);
  });

  it('content 非字符串时降级为原始文本', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = '{"content":123}';
    expect(parseWorkflowResponse(raw).content).toBe(raw);
  });

  it('next 非数组时按格式失败容错：content 合法则保留 content', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = '{"content":"c","next":"not-an-array"}';
    expect(parseWorkflowResponse(raw).content).toBe('c');
    const detailed = parseWorkflowResponseDetailed(raw);
    expect(detailed.success).toBe(false);
    expect(detailed.error).toContain('next 必须是数组');
    expect(detailed.response.content).toBe('c');
  });

  it('额外字段被忽略但整体仍算有效', () => {
    const r = parseWorkflowResponse('{"content":"c","status":"ok"}');
    expect(r.content).toBe('c');
  });

  it('next 中存在非法调用项时整体按格式失败处理：content 保留、next 整体丢弃', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseWorkflowResponse(
      '{"content":"c","next":[{"mcp":"t","args":{}},{"tool":"bad"}]}'
    );
    expect(r.content).toBe('c');
    expect(r.next).toBeUndefined();
    expect(shouldTerminate(r)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();

    const allInvalid = parseWorkflowResponse('{"content":"c","next":[{"bad":1}]}');
    expect(allInvalid.next).toBeUndefined();
    expect(shouldTerminate(allInvalid)).toBe(true);
  });
});

describe('parseWorkflowResponseDetailed - 带详细结果', () => {
  it('成功时返回 response 与 rawJson', () => {
    const raw = '{"content":"c","next":[{"mcp":"t","args":{"k":1}}]}';
    const r = parseWorkflowResponseDetailed(raw);
    expect(r.success).toBe(true);
    expect(r.response.next).toHaveLength(1);
    expect(r.rawJson).toBe(raw);
    expect(r.error).toBeUndefined();
  });

  it('无法提取 JSON 时失败并回传原始文本', () => {
    const r = parseWorkflowResponseDetailed('no json');
    expect(r.success).toBe(false);
    expect(r.error).toContain('无法从响应中提取 JSON');
    expect(r.response.content).toBe('no json');
  });

  it('格式校验失败时返回错误明细', () => {
    const r = parseWorkflowResponseDetailed('{"next":[]}');
    expect(r.success).toBe(false);
    expect(r.error).toContain('缺少必填字段 content');
    expect(r.rawJson).toBe('{"next":[]}');
  });

  it('JSON 语法错误时返回解析错误', () => {
    const r = parseWorkflowResponseDetailed('{oops}');
    expect(r.success).toBe(false);
    expect(r.error).toContain('JSON 解析失败');
  });
});

describe('shouldTerminate / checkTermination - 终止判定', () => {
  it('无 next / 空 next 都终止', () => {
    expect(shouldTerminate({ content: 'done' })).toBe(true);
    expect(shouldTerminate({ content: 'done', next: [] })).toBe(true);
    expect(
      shouldTerminate({ content: 'c', next: [{ mcp: 't', args: {} }] })
    ).toBe(false);
  });

  it('checkTermination 区分无 next / 空 next / 继续', () => {
    expect(checkTermination({ content: 'c' })).toMatchObject({
      shouldTerminate: true,
      reason: 'no_next',
    });
    expect(checkTermination({ content: 'c', next: [] })).toMatchObject({
      shouldTerminate: true,
      reason: 'empty_next',
    });
    const cont = checkTermination({ content: 'c', next: [{ mcp: 't', args: {} }] });
    expect(cont.shouldTerminate).toBe(false);
    expect(cont.reason).toBe('continue');
    expect(cont.description).toContain('1 个 MCP 调用');
  });

  it('content 含完成关键词但 next 非空时仅告警不终止', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = checkTermination({
      content: '任务完成',
      next: [{ mcp: 't', args: {} }],
    });
    expect(r.shouldTerminate).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('cleanFinalOutput - 输出清理', () => {
  it('移除"用户想要/询问..."前缀', () => {
    expect(cleanFinalOutput('用户想要画一只猫。这是猫。')).toBe('这是猫。');
    expect(cleanFinalOutput('用户询问天气。晴天。')).toBe('晴天。');
    // 单句文本：前缀正则 [^。]*。 会吞掉唯一句子，清理后为空时返回原始内容
    expect(cleanFinalOutput('根据用户的请求，已生成。')).toBe('根据用户的请求，已生成。');
  });

  it('移除"任务已完成，无需进一步操作"类后缀（连同前置标点）', () => {
    expect(cleanFinalOutput('图片已生成。任务已完成，无需进一步操作。')).toBe('图片已生成');
    expect(cleanFinalOutput('处理好了。工作流已终止。')).toBe('处理好了');
    expect(cleanFinalOutput('结果在此，无需进一步操作')).toBe('结果在此');
  });

  it('前后缀同时移除', () => {
    const raw = '用户请求生成图片。图片已经准备好了。任务已完成，无需进一步操作。';
    expect(cleanFinalOutput(raw)).toBe('图片已经准备好了');
  });

  it('清理后为空时返回原始内容', () => {
    const raw = '任务已完成，无需进一步操作。';
    expect(cleanFinalOutput(raw)).toBe(raw);
  });

  it('空串原样返回', () => {
    expect(cleanFinalOutput('')).toBe('');
  });
});

describe('filterMarkdownImages - 图片过滤', () => {
  it('空串原样返回', () => {
    expect(filterMarkdownImages('')).toBe('');
  });

  it('base64 Markdown 图片被替换', () => {
    const text = '前文 ![alt](data:image/png;base64,iVBOR) 后文';
    expect(filterMarkdownImages(text)).toBe('前文 [图片已过滤] 后文');
  });

  it('超长 URL 图片（≥50 字符）被替换，短 URL 保留', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(50);
    expect(filterMarkdownImages(`![x](${longUrl})`)).toBe('[图片已过滤]');
    expect(filterMarkdownImages('![x](https://a.io/pic.png)')).toBe(
      '![x](https://a.io/pic.png)'
    );
  });

  it('HTML img 的 base64 / 超长 src 被替换（大小写不敏感）', () => {
    expect(filterMarkdownImages('<img src="data:image/png;base64,AAA">')).toBe('[图片已过滤]');
    expect(filterMarkdownImages('<IMG SRC="data:image/jpeg;base64,AAA"/>')).toBe('[图片已过滤]');
    const longSrc = 'https://x/' + 'b'.repeat(200);
    expect(filterMarkdownImages(`<img src="${longSrc}">`)).toBe('[图片已过滤]');
  });

  it('普通文本原样返回', () => {
    expect(filterMarkdownImages('普通 **markdown** 文本')).toBe('普通 **markdown** 文本');
  });
});

describe('getWorkflowSystemPrompt - 系统提示词构建', () => {
  it('无工具时输出"(无可用工具)"', () => {
    expect(getWorkflowSystemPrompt([])).toContain('(无可用工具)');
  });

  it('工具列表带描述、参数说明与必填标记', () => {
    const tools: MCPTool[] = [
      {
        name: 'generate_image',
        description: '生成图片',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '提示词' },
            count: { type: 'number' },
          },
          required: ['prompt'],
        },
      },
    ];
    const prompt = getWorkflowSystemPrompt(tools);
    expect(prompt).toContain('- generate_image: 生成图片');
    expect(prompt).toContain('prompt*: 提示词');
    expect(prompt).toContain('count: number');
  });

  it('缺省描述与参数时使用占位文案', () => {
    const tools: MCPTool[] = [
      {
        name: 't1',
        description: '',
        inputSchema: { type: 'object' },
      },
    ];
    const prompt = getWorkflowSystemPrompt(tools);
    expect(prompt).toContain('- t1: 无描述');
    expect(prompt).toContain('(无参数)');
  });
});

describe('getWorkflowUserPrompt - 用户提示词构建', () => {
  it('旧签名（位置参数）包含请求 / 上一步输出 / 上下文', () => {
    const p = getWorkflowUserPrompt('画猫', '上一步结果', '页面上下文');
    expect(p).toContain('## 用户请求\n画猫');
    expect(p).toContain('## 上一步输出\n上一步结果');
    expect(p).toContain('## 上下文\n页面上下文');
    expect(p).toContain('请分析并返回 JSON 格式的响应');
  });

  it('告警消息置于最前', () => {
    const p = getWorkflowUserPrompt({
      userRequest: 'r',
      warningMessage: '⚠️ 循环警告',
    });
    expect(p.startsWith('⚠️ 循环警告')).toBe(true);
  });

  it('剩余迭代次数 ≤5 时插入倒计时提示', () => {
    const urgent = getWorkflowUserPrompt({ userRequest: 'r', currentIteration: 16, maxIterations: 20 });
    expect(urgent).toContain('剩余迭代次数: 4/20');
    const relaxed = getWorkflowUserPrompt({ userRequest: 'r', currentIteration: 10, maxIterations: 20 });
    expect(relaxed).not.toContain('剩余迭代次数');
  });

  it('超长上一步输出与上下文被截断', () => {
    const p = getWorkflowUserPrompt({
      userRequest: 'r',
      previousOutput: 'x'.repeat(30001),
      pageContext: 'y'.repeat(20001),
    });
    expect(p).toContain('...(已截断)');
    expect(p).not.toContain('x'.repeat(30001));
    // 上一步截断保留 20000 字符
    expect(p).toContain('x'.repeat(20000));
    expect(p).not.toContain('y'.repeat(20001));
  });
});

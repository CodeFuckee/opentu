import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMissingVariables,
  needsApiKeyConfiguration,
  processToolUrl,
  replaceTemplateVariables,
} from './url-template';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
}));

vi.mock('./settings-manager', () => ({
  geminiSettings: {
    get: getMock,
  },
}));

// 与实现中的 TRUSTED_TEMPLATE_ORIGINS 保持一致
const TRUSTED_ORIGIN = 'https://vercel.ddaiai.com';

describe('url-template 敏感变量可信源白名单', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('可信源且 Key 已配置时正常注入', () => {
    getMock.mockReturnValue({ apiKey: 'sk-test', baseUrl: 'https://api.tu-zi.com' });

    const url = TRUSTED_ORIGIN + '/#/?settings={"key":"${apiKey}","url":"${baseUrl}"}';
    const { url: processed, missingVariables } = processToolUrl(url);

    expect(processed).toContain('sk-test');
    expect(processed).toContain('https://api.tu-zi.com');
    expect(missingVariables).toEqual([]);
  });

  it('可信源但 Key 未配置时保留模板并提示缺失', () => {
    getMock.mockReturnValue({ apiKey: '', baseUrl: '' });

    const url = TRUSTED_ORIGIN + '/#/?key=${apiKey}';
    expect(getMissingVariables(url)).toEqual(['apiKey']);
    expect(needsApiKeyConfiguration(url)).toBe(true);
    // 保留模板，等待用户配置后刷新注入
    expect(replaceTemplateVariables(url)).toContain('${apiKey}');
  });

  it('不可信源不注入敏感变量，也不提示缺失', () => {
    getMock.mockReturnValue({ apiKey: 'sk-test', baseUrl: 'https://api.tu-zi.com' });

    const url = 'https://evil.example.com/frame#${apiKey}';
    const { url: processed, missingVariables } = processToolUrl(url);

    // Key 不外发
    expect(processed).not.toContain('sk-test');
    // 不引导用户为永远不会注入的工具配置 Key
    expect(missingVariables).toEqual([]);
    expect(needsApiKeyConfiguration(url)).toBe(false);
  });

  it('不可信源的敏感变量替换为空串而非保留模板字面量', () => {
    getMock.mockReturnValue({ apiKey: 'sk-test', baseUrl: '' });

    const url = 'https://user-custom.example.com/tool?key=${apiKey}&base=${baseUrl}';
    const processed = replaceTemplateVariables(url);

    expect(processed).toBe('https://user-custom.example.com/tool?key=&base=');
  });

  it('非敏感变量不受白名单限制', () => {
    getMock.mockReturnValue({ apiKey: '', baseUrl: '' });

    // 未注册变量保留原始模板（既有约定）
    const url = 'https://example.com/?q=${foo}';
    expect(replaceTemplateVariables(url)).toBe('https://example.com/?q=${foo}');
    // 未注册变量按缺失上报（既有约定）
    expect(getMissingVariables(url)).toEqual(['foo']);
  });

  it('无法解析的 URL 按不可信处理', () => {
    getMock.mockReturnValue({ apiKey: 'sk-test', baseUrl: '' });

    const processed = replaceTemplateVariables('not a url?key=${apiKey}');
    expect(processed).not.toContain('sk-test');
  });
});

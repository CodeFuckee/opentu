/**
 * URL 模板变量处理工具
 *
 * 支持在 URL 中使用模板变量，如 ${apiKey}
 * 变量会在运行时被替换为实际值
 */

import { geminiSettings } from './settings-manager';

/**
 * 支持的模板变量
 */
export type TemplateVariable = 'apiKey' | 'baseUrl';

/**
 * 模板变量映射表
 */
const VARIABLE_GETTERS: Record<TemplateVariable, () => string> = {
  apiKey: () => geminiSettings.get().apiKey || '',
  baseUrl: () => geminiSettings.get().baseUrl || '',
};

/**
 * 允许注入敏感模板变量（${apiKey}/${baseUrl}）的可信工具源白名单。
 *
 * 工具元素 URL 随画板数据流转（导入/粘贴/自定义添加），来源不可信：
 * 不设白名单时，恶意分享的画板可以用 ${apiKey} 模板把用户 Key 注入任意
 * 第三方站点并收割。当前仅内置的 ChatGPT-Next-Web 式绘图工具需要在
 * URL 中携带 Key（该站点的 settings 协议只认 URL 参数，属既定接受风险）。
 */
const TRUSTED_TEMPLATE_ORIGINS = new Set(['https://vercel.ddaiai.com']);

function isTrustedTemplateOrigin(url: string): boolean {
  try {
    return TRUSTED_TEMPLATE_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * 变量是否允许注入到该 URL：非敏感变量恒允许；敏感变量仅对可信源生效
 */
function canInjectVariable(url: string, variableName: string): boolean {
  if (variableName !== 'apiKey' && variableName !== 'baseUrl') {
    return true;
  }
  return isTrustedTemplateOrigin(url);
}

/**
 * 检查 URL 是否包含模板变量
 * @param url URL 字符串
 * @returns 是否包含模板变量
 */
export function hasTemplateVariables(url: string): boolean {
  return /\$\{(\w+)\}/.test(url);
}

/**
 * 提取 URL 中的所有模板变量
 * @param url URL 字符串
 * @returns 变量名列表
 */
export function extractTemplateVariables(url: string): string[] {
  const matches = url.matchAll(/\$\{(\w+)\}/g);
  const variables: string[] = [];
  for (const match of matches) {
    if (!variables.includes(match[1])) {
      variables.push(match[1]);
    }
  }
  return variables;
}

/**
 * 检查哪些模板变量的值缺失
 * @param url URL 字符串
 * @returns 缺失值的变量列表
 */
export function getMissingVariables(url: string): string[] {
  const variables = extractTemplateVariables(url);
  const missing: string[] = [];

  for (const variable of variables) {
    // 不可信源的敏感变量不注入也不提示缺失（避免引导用户配置一个永远不会被使用的 Key）
    if (!canInjectVariable(url, variable)) {
      continue;
    }
    const getter = VARIABLE_GETTERS[variable as TemplateVariable];
    if (getter) {
      const value = getter();
      if (!value) {
        missing.push(variable);
      }
    } else {
      // 不支持的变量视为缺失
      missing.push(variable);
    }
  }

  return missing;
}

/**
 * 替换 URL 中的模板变量
 * 敏感变量（apiKey/baseUrl）仅注入可信源白名单；其余来源一律替换为空串，
 * 杜绝 Key 经画板流转的任意工具 URL 外发
 * @param url URL 字符串
 * @returns 替换后的 URL
 */
export function replaceTemplateVariables(url: string): string {
  return url.replace(/\$\{(\w+)\}/g, (match, variableName) => {
    const getter = VARIABLE_GETTERS[variableName as TemplateVariable];
    if (!getter) {
      return match; // 不支持的变量保留原始模板
    }
    if (!canInjectVariable(url, variableName)) {
      return '';
    }
    const value = getter();
    return value || match; // 如果值为空，保留原始模板
  });
}

/**
 * 处理工具 URL，进行模板变量替换
 * @param url 原始 URL
 * @returns { url: 替换后的URL, missingVariables: 缺失的变量列表 }
 */
export function processToolUrl(url: string): {
  url: string;
  missingVariables: string[];
} {
  if (!url || !hasTemplateVariables(url)) {
    return { url, missingVariables: [] };
  }

  const missingVariables = getMissingVariables(url);
  const processedUrl = replaceTemplateVariables(url);

  return {
    url: processedUrl,
    missingVariables,
  };
}

/**
 * 检查是否需要配置 API Key
 * 如果 URL 包含 ${apiKey} 且 API Key 未配置，返回 true
 * @param url URL 字符串
 * @returns 是否需要配置 API Key
 */
export function needsApiKeyConfiguration(url: string): boolean {
  if (!url) return false;
  const missingVariables = getMissingVariables(url);
  return missingVariables.includes('apiKey');
}

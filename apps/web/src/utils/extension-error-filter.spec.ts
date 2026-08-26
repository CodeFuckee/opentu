/**
 * 浏览器扩展错误过滤单测
 *
 * 复现：登录后控制台刷出 1000+ 条
 *   "Uncaught (in promise) TypeError: Failed to fetch
 *    at qC.nativeFetch (api.service.ts:1336) ... at s (background.js:2:2469938)"
 * 该错误栈全部位于浏览器扩展脚本（api.service.ts / background.js），与项目无关。
 *
 * 修复目标：能识别"来自扩展的错误"，使崩溃监控不再把扩展错误当作项目崩溃记录。
 */
import { describe, it, expect } from 'vitest';
import { isExtensionError } from './extension-error-filter';

describe('isExtensionError', () => {
  it('REPRO BUG: 栈含 background.js + api.service.ts 的 Failed to fetch 应判定为扩展错误', () => {
    const error = new TypeError('Failed to fetch');
    (error as Error & { stack?: string }).stack = `
      TypeError: Failed to fetch
          at qC.nativeFetch (api.service.ts:1336:12)
          at i (api.service.ts:1331:73)
          at qC.<anonymous> (api.service.ts:1332:12)
          at Generator.next (<anonymous>)
          at s (background.js:2:2469938)
    `;
    expect(isExtensionError(error)).toBe(true);
  });

  it('栈含 chrome-extension:// 的脚本错误应判定为扩展错误', () => {
    const error = new Error('Failed to fetch');
    (error as Error & { stack?: string }).stack = `
      Error: Failed to fetch
          at chrome-extension://abcde12345/background.js:42:7
    `;
    expect(isExtensionError(error)).toBe(true);
  });

  it('消息含 "Extension context invalidated" 应判定为扩展错误', () => {
    expect(
      isExtensionError(
        new Error('Extension context invalidated.'),
        'Extension context invalidated.'
      )
    ).toBe(true);
  });

  it('项目自身的错误不应被误判为扩展错误', () => {
    const error = new TypeError('Failed to fetch');
    (error as Error & { stack?: string }).stack = `
      TypeError: Failed to fetch
          at getBoard (http://localhost:7200/src/app/app.tsx:123:10)
          at http://localhost:7200/src/main.tsx:45:5
    `;
    expect(isExtensionError(error)).toBe(false);
  });

  it('无栈信息的普通错误不应被误判（默认不是扩展错误）', () => {
    expect(isExtensionError(new Error('something broke'))).toBe(false);
  });

  it('非 Error 类型的 rejection reason 也能安全处理', () => {
    expect(isExtensionError('plain string reason')).toBe(false);
    expect(isExtensionError(undefined)).toBe(false);
    expect(isExtensionError(null)).toBe(false);
  });
});

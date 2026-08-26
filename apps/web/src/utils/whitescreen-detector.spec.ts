/**
 * 白屏检测 · 画板缺失判定单测
 *
 * 复现并锁定"画板组件未加载"误报 bug：
 * AuthGate 在未登录时只渲染登录页（不挂载 .plait-board-container），
 * 原实现会把它误判为白屏上报。
 */
import { describe, it, expect } from 'vitest';
import { shouldReportBoardMissing } from './whitescreen-detector';

describe('shouldReportBoardMissing', () => {
  it('画板存在时不判为白屏', () => {
    const result = shouldReportBoardMissing({
      hasContent: true,
      hasPlaitBoard: true,
      pathname: '/',
      isBoardHidden: false,
    });
    expect(result).toBe(false);
  });

  it('未渲染内容时不走"画板未加载"分支（属于 React 未渲染）', () => {
    const result = shouldReportBoardMissing({
      hasContent: false,
      hasPlaitBoard: false,
      pathname: '/',
      isBoardHidden: false,
    });
    expect(result).toBe(false);
  });

  it('非首页（非根路径）不强制要求画板', () => {
    const result = shouldReportBoardMissing({
      hasContent: true,
      hasPlaitBoard: false,
      pathname: '/login',
      isBoardHidden: false,
    });
    expect(result).toBe(false);
  });

  it('已渲染内容、首页、且画板缺失时判定为白屏（原始缺陷条件）', () => {
    const result = shouldReportBoardMissing({
      hasContent: true,
      hasPlaitBoard: false,
      pathname: '/',
      isBoardHidden: false,
    });
    expect(result).toBe(true);
  });

  it('REPRO BUG: AuthGate 登录门禁使画板被有意隐藏时，不应判为白屏', () => {
    const result = shouldReportBoardMissing({
      hasContent: true,
      hasPlaitBoard: false,
      pathname: '/',
      isBoardHidden: true,
    });
    expect(result).toBe(false);
  });
});

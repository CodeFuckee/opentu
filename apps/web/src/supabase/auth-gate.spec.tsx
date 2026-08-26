/**
 * AuthGate 启动门禁单测
 *
 * 复现"卡在 88% 正在唤起工作台" bug：
 * 白屏 boot 覆盖层（index.html 的 #app-boot-loading）只能通过
 * bootController.markReady() 移除，而 markReady 原本只在 <App/> 内部调用。
 * AuthGate 在未登录时只渲染登录页、不渲染 <App/> => markReady 永远不被调用，
 * boot 覆盖层永远卡在前端 bootstrap 的最后进度（88%）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { AuthGate } from './auth-gate';

const { mockedAuth } = vi.hoisted(() => ({
  mockedAuth: {
    status: { state: 'unauthenticated' },
    isReady: true,
    user: null,
    signUp: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  } as {
    status: { state: string; session?: unknown; user?: unknown };
    isReady: boolean;
    user: { email?: string } | null;
    signUp: ReturnType<typeof vi.fn>;
    signIn: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  },
}));

vi.mock('./auth-context', () => ({
  useAuth: () => mockedAuth,
}));

type BootController = {
  markReady: () => void;
  setProgress: () => void;
  markError: () => void;
};

function fakeBootController(): BootController {
  return {
    markReady: vi.fn(),
    setProgress: vi.fn(),
    markError: vi.fn(),
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __OPENTU_BOOT__: BootController | undefined;
}

describe('AuthGate boot-ready signaling', () => {
  let boot: BootController;

  beforeEach(() => {
    boot = fakeBootController();
    globalThis.__OPENTU_BOOT__ = boot;
    vi.clearAllMocks();
    // 默认未登录
    mockedAuth.status = { state: 'unauthenticated' };
    mockedAuth.isReady = true;
    mockedAuth.user = null;
  });

  it('REPRO BUG: 未登录(isReady 且 unauthenticated)时，登录页已渲染，应标记 boot ready 以移除 boot 覆盖层', () => {
    render(
      <AuthGate>
        <div>工作区</div>
      </AuthGate>
    );

    // 登录门禁已渲染出登录页，boot 覆盖层必须被移除，否则页面卡在 88%
    expect(boot.markReady).toHaveBeenCalledTimes(1);
  });

  it('已登录时渲染工作区，AuthGate 也应在会话就绪后标记 boot ready', () => {
    mockedAuth.status = {
      state: 'authenticated',
      session: {},
      user: { email: 'a@b.com' },
    };
    mockedAuth.user = { email: 'a@b.com' };

    render(
      <AuthGate>
        <div>工作区</div>
      </AuthGate>
    );

    expect(boot.markReady).toHaveBeenCalledTimes(1);
  });

  it('会话未就绪（isReady=false）时，尚未渲染出决定性的页面，不应标记 boot ready', () => {
    mockedAuth.status = { state: 'unknown' };
    mockedAuth.isReady = false;

    render(
      <AuthGate>
        <div>工作区</div>
      </AuthGate>
    );

    expect(boot.markReady).not.toHaveBeenCalled();
  });
});

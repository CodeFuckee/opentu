/**
 * AuthGate 启动门禁单测
 *
 * 覆盖两类行为：
 * 1. boot ready 信号：会话就绪后必须调用 markReady()，否则 boot 覆盖层卡在 88%。
 * 2. 内联登录表单：未登录且会话就绪时，直接在门禁卡片内渲染 AuthForm（非弹窗）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthGate } from './auth-gate';

const { mockedAuth, formProps } = vi.hoisted(() => ({
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
  formProps: {
    rendered: false,
    mode: 'signin',
  } as { rendered: boolean; mode: string },
}));

vi.mock('./auth-context', () => ({
  useAuth: () => mockedAuth,
}));

vi.mock('./auth-form', () => ({
  AuthForm: (props: { mode: string; onModeChange: () => void }) => {
    formProps.rendered = true;
    formProps.mode = props.mode;
    return <div data-testid="mock-auth-form" />;
  },
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

describe('AuthGate', () => {
  let boot: BootController;

  beforeEach(() => {
    boot = fakeBootController();
    globalThis.__OPENTU_BOOT__ = boot;
    vi.clearAllMocks();
    // 默认未登录
    mockedAuth.status = { state: 'unauthenticated' };
    mockedAuth.isReady = true;
    mockedAuth.user = null;
    formProps.rendered = false;
    formProps.mode = 'signin';
  });

  describe('boot-ready signaling', () => {
    it('未登录(isReady 且 unauthenticated)时，应标记 boot ready 以移除 boot 覆盖层', () => {
      render(
        <AuthGate>
          <div>工作区</div>
        </AuthGate>
      );
      expect(boot.markReady).toHaveBeenCalledTimes(1);
    });

    it('已登录时渲染工作区，也应在会话就绪后标记 boot ready', () => {
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

    it('会话未就绪（isReady=false）时，不应标记 boot ready', () => {
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

  describe('inline auth form', () => {
    it('未登录且会话就绪时，直接在门禁内渲染登录表单（非弹窗）', () => {
      render(
        <AuthGate>
          <div>工作区</div>
        </AuthGate>
      );
      // AuthForm 已渲染且为 signin 模式
      expect(formProps.rendered).toBe(true);
      expect(formProps.mode).toBe('signin');
      // 门禁容器存在（表单内联其中，而不是 Dialog 弹窗）
      expect(screen.getByTestId('auth-gate')).toBeTruthy();
      // 不渲染工作区
      expect(screen.queryByText('工作区')).toBeNull();
    });

    it('已登录时不渲染登录表单，直接渲染工作区', () => {
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
      expect(formProps.rendered).toBe(false);
      expect(screen.getByText('工作区')).toBeTruthy();
    });

    it('已登录时不渲染右上角用户入口（用户入口已移到左侧工具栏，由 App 注入）', () => {
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

      // AuthGate 不再渲染用户入口
      expect(screen.queryByTestId('user-bar')).toBeNull();
      expect(screen.queryByTestId('user-menu')).toBeNull();
    });

    it('会话未就绪（isReady=false）时不渲染登录表单', () => {
      mockedAuth.status = { state: 'unknown' };
      mockedAuth.isReady = false;

      render(
        <AuthGate>
          <div>工作区</div>
        </AuthGate>
      );
      expect(formProps.rendered).toBe(false);
    });
  });
});

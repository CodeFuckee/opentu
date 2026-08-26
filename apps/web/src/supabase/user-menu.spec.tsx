/**
 * UserMenu 单测
 *
 * 用户入口渲染在左侧工具栏底部（由 App 注入 Drawnix 的 toolbarBottomExtra），
 * 显示用户首字符头像，点击可退出登录。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserMenu } from './user-menu';

const { mockedAuth } = vi.hoisted(() => ({
  mockedAuth: {
    status: { state: 'authenticated' },
    isReady: true,
    user: {
      email: 'alice@example.com',
      user_metadata: {},
    } as {
      email?: string;
      user_metadata: Record<string, unknown>;
    } | null,
    signUp: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  } as {
    status: { state: string };
    isReady: boolean;
    user: {
      email?: string;
      user_metadata: Record<string, unknown>;
    } | null;
    signUp: ReturnType<typeof vi.fn>;
    signIn: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  },
}));

vi.mock('./auth-context', () => ({
  useAuth: () => mockedAuth,
}));

describe('UserMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.user = {
      email: 'alice@example.com',
      user_metadata: {},
    };
  });

  it('无 display name 时渲染邮箱首字符头像', () => {
    render(<UserMenu />);
    expect(screen.getByTestId('user-menu')).toBeTruthy();
    expect(screen.getByText('a')).toBeTruthy();
  });

  it('有 display name 时渲染 display name 首字头像', () => {
    mockedAuth.user = {
      email: 'alice@example.com',
      user_metadata: { full_name: 'Alice Wang' },
    };
    render(<UserMenu />);
    expect(screen.getByText('A')).toBeTruthy();
  });

  it('未登录（无 user）时不渲染', () => {
    mockedAuth.user = null;
    const { container } = render(<UserMenu />);
    expect(container.firstChild).toBeNull();
  });

  it('点击退出登录菜单项时调用 signOut', async () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByTestId('user-menu-button'));
    // TDesign Dropdown 异步渲染菜单，等待其出现
    const logoutItem = await screen.findAllByText('退出登录');
    fireEvent.click(logoutItem[logoutItem.length - 1]);
    expect(mockedAuth.signOut).toHaveBeenCalledTimes(1);
  });
});

/**
 * 认证门禁
 *
 * 在会话就绪前显示加载态；未登录时在门禁卡片内直接渲染登录/注册表单（非弹窗）；
 * 已登录后渲染工作区。另提供右上角的用户入口（显示当前用户并可退出登录）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Dropdown, MessagePlugin } from 'tdesign-react';
import { useAuth } from './auth-context';
import { AuthForm, type AuthMode } from './auth-form';
import styles from './auth-gate.module.scss';

interface AuthGateProps {
  children: ReactNode;
}

type BootController = {
  markReady: () => void;
  markError: (message?: string) => void;
};

function getBootController(): BootController | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return (window as Window & { __OPENTU_BOOT__?: BootController })
    .__OPENTU_BOOT__ || null;
}

export function AuthGate({ children }: AuthGateProps) {
  const { status, isReady, user, signOut } = useAuth();
  const [mode, setMode] = useState<AuthMode>('signin');

  const isAuthenticated = status.state === 'authenticated';

  // 会话一旦就绪，页面就会渲染出"决定性的界面"（登录页，或已登录的工作区）。
  // boot 覆盖层 (#app-boot-loading) 只能通过 markReady() 移除，而 markReady 原本
  // 只在 <App/> 内部调用；未登录时 <App/> 不会被挂载，因此这里必须自行标记 ready，
  // 否则 boot 覆盖层会永远停留在 88% "正在唤起工作台"。多次调用是幂等的。
  useEffect(() => {
    if (!isReady) {
      return;
    }
    getBootController()?.markReady();
  }, [isReady]);

  const handleLogout = useCallback(async () => {
    await signOut();
    MessagePlugin.success('已退出登录');
  }, [signOut]);

  const handleUserMenuClick = useCallback(
    (data: { value?: unknown }) => {
      if (data.value === 'logout') {
        void handleLogout();
      }
    },
    [handleLogout]
  );

  if (!isReady) {
    return (
      <div
        className={styles.loading}
        data-whitescreen-hidden="auth-gate"
        data-testid="auth-gate-loading"
      >
        <span className={styles.loadingDot} />
        正在恢复登录状态...
      </div>
    );
  }

  return isAuthenticated ? (
    <>
      {children}
      <div className={styles.userBar}>
        <Dropdown
          trigger="click"
          placement="bottom-right"
          options={[{ content: '退出登录', value: 'logout' }]}
          onClick={handleUserMenuClick}
        >
          <Button
            variant="outline"
            shape="round"
            className={styles.userButton}
          >
            {user?.email ?? '用户'}
          </Button>
        </Dropdown>
      </div>
    </>
  ) : (
    <div
      className={styles.gate}
      data-whitescreen-hidden="auth-gate"
      data-testid="auth-gate"
    >
      <div className={styles.gateCard}>
        <div className={styles.gateLogo}>OpenTu</div>
        <AuthForm mode={mode} onModeChange={setMode} />
      </div>
    </div>
  );
}

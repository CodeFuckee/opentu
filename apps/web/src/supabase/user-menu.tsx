/**
 * 左侧工具栏底部用户入口
 *
 * 显示用户首字符头像（display name 非空取 display name 首字，否则取邮箱首字符），
 * hover 显示完整邮箱，点击弹出「退出登录」菜单。
 * 渲染位置：由 Drawnix 的 toolbarBottomExtra 注入到左侧工具栏底部区域
 * （任务队列按钮下方）。
 */
import { useCallback } from 'react';
import { Button, Dropdown, MessagePlugin, Tooltip } from 'tdesign-react';
import { useAuth } from './auth-context';
import { getUserAvatarChar } from './user-avatar';
import styles from './user-menu.module.scss';

export function UserMenu() {
  const { user, signOut } = useAuth();

  const handleLogout = useCallback(async () => {
    await signOut();
    MessagePlugin.success('已退出登录');
  }, [signOut]);

  const handleMenuClick = useCallback(
    (data: { value?: unknown }) => {
      if (data.value === 'logout') {
        void handleLogout();
      }
    },
    [handleLogout]
  );

  if (!user) {
    return null;
  }

  const avatarChar = getUserAvatarChar(user);

  return (
    <div className={styles.userMenu} data-testid="user-menu">
      <Tooltip
        content={user.email ?? '用户'}
        placement="right"
        theme="light"
      >
        <Dropdown
          trigger="click"
          placement="right-top"
          options={[{ content: '退出登录', value: 'logout' }]}
          onClick={handleMenuClick}
        >
          <Button
            variant="outline"
            shape="round"
            className={styles.userButton}
            data-testid="user-menu-button"
          >
            <span className={styles.avatar}>{avatarChar}</span>
          </Button>
        </Dropdown>
      </Tooltip>
    </div>
  );
}

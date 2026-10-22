/**
 * 同步状态指示器渲染测试
 *
 * 守护点（refactor-cloud-native-sync Phase B 修复回归）：
 * 指示器此前依赖同步设置弹窗的 SupabaseSyncProvider——主界面无 Provider 时
 * 组件返回 null，工具栏上「找不到云同步指示器」。修复后组件直订 SyncPusher
 * 状态 + runtime 配置，不依赖 Provider 即可渲染。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import { getSupabaseSyncConfig } from '../../services/supabase-sync/runtime';
import { ensureSyncInfraStarted } from '../../services/supabase-sync/sync-pusher';
import { clearOutbox } from '../../services/supabase-sync/outbox';

vi.mock('../../services/supabase-sync/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/supabase-sync/runtime')>();
  return {
    ...actual,
    getSupabaseSyncConfig: vi.fn(() => null),
  };
});

vi.mock('../../services/supabase-sync/sync-pusher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/supabase-sync/sync-pusher')>();
  return {
    ...actual,
    ensureSyncInfraStarted: vi.fn(),
  };
});

vi.mock('../startup/DeferredSyncSettings', () => ({
  default: (props: { visible: boolean }) => (
    <div data-testid="deferred-sync-settings" data-visible={String(props.visible)} />
  ),
}));

vi.mock('../shared', () => ({
  HoverTip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('SyncStatusIndicator', () => {
  beforeEach(async () => {
    cleanup();
    await clearOutbox();
    vi.mocked(getSupabaseSyncConfig).mockReturnValue(null);
  });

  it('未登录（未注册同步配置）时不渲染', () => {
    const { container } = render(<SyncStatusIndicator />);
    expect(container.querySelector('.sync-status-indicator')).toBeNull();
    expect(ensureSyncInfraStarted).toHaveBeenCalled();
  });

  it('已登录（宿主注册配置）时无需弹窗 Provider 即渲染', () => {
    vi.mocked(getSupabaseSyncConfig).mockReturnValue({
      client: {},
    } as never);
    render(<SyncStatusIndicator />);
    expect(
      document.querySelector('.sync-status-indicator')
    ).not.toBeNull();
    expect(screen.getByLabelText('同步设置')).toBeTruthy();
    // 弹窗未点开时不挂载（SyncSettings 内部消费 useSupabaseSync，
    // 常驻挂载会在无 Provider 的主界面抛错——回归守护点）
    expect(screen.queryByTestId('deferred-sync-settings')).toBeNull();
  });

  it('点击指示器后按需挂载同步设置弹窗（含 Provider）', async () => {
    vi.mocked(getSupabaseSyncConfig).mockReturnValue({
      client: {},
    } as never);
    render(<SyncStatusIndicator />);
    fireEvent.click(screen.getByLabelText('同步设置'));
    const dialog = await waitFor(() =>
      screen.getByTestId('deferred-sync-settings')
    );
    expect(dialog.getAttribute('data-visible')).toBe('true');
  });
});

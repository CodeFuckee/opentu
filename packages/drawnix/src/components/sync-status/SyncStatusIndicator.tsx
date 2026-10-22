/**
 * 同步状态指示器组件
 * 显示在工具栏上，点击可打开同步设置（基于 Supabase 云同步）
 *
 * 状态来源（refactor-cloud-native-sync Phase B）：优先取 SupabaseSyncContext
 * （同步设置弹窗内可用），主界面上直接订阅 SyncPusher 状态——推送器随主应用
 * 挂载即启动（ensureSyncInfraStarted），不依赖弹窗 Provider。
 */

import React, { useEffect, useState } from 'react';
import { Loading } from 'tdesign-react';
import {
  CheckCircleFilledIcon,
  CloudUploadIcon,
  CloseCircleFilledIcon,
} from 'tdesign-icons-react';
import { useSupabaseSyncOptional } from '../../contexts/SupabaseSyncContext';
import {
  ensureSyncInfraStarted,
  syncPusher,
  type SyncPusherStatus,
} from '../../services/supabase-sync/sync-pusher';
import { getSupabaseSyncConfig } from '../../services/supabase-sync/runtime';
import './sync-status.scss';
import { HoverTip } from '../shared';

/**
 * 同步设置弹窗：懒加载 DeferredSyncSettings（内含 SupabaseSyncProvider 包裹——
 * SyncSettings 内部消费 useSupabaseSync，必须由 Provider 提供；点开时才挂载，
 * 不拖累主包体积，也与「云同步设置」菜单入口同一组件）
 */
const DeferredSyncSettings = React.lazy(
  () => import('../startup/DeferredSyncSettings')
);

/**
 * 同步状态指示器
 */
export function SyncStatusIndicator() {
  const syncContext = useSupabaseSyncOptional();
  const [showSettings, setShowSettings] = useState(false);
  const [pusherStatus, setPusherStatus] = useState<SyncPusherStatus>({
    pending: 0,
    syncing: false,
    online:
      typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  });
  const [configured, setConfigured] = useState(() =>
    Boolean(getSupabaseSyncConfig())
  );

  useEffect(() => {
    // 幂等：主应用已启动过则直接复用；独立挂载场景兜底启动
    ensureSyncInfraStarted();
    const unsubscribe = syncPusher.onStatus(setPusherStatus);
    // 登录态由宿主异步注册，轮询跟进（与 SupabaseSyncContext 同模式）
    const poll = setInterval(() => {
      setConfigured(Boolean(getSupabaseSyncConfig()));
    }, 1000);
    return () => {
      unsubscribe();
      clearInterval(poll);
    };
  }, []);

  // 未登录（宿主未注册同步配置）不显示，保持工具栏干净
  if (!configured && !syncContext?.isConfigured) {
    return null;
  }

  const isSyncing = (syncContext?.isSyncing ?? false) || pusherStatus.syncing;
  const pendingCount = syncContext?.pendingSyncCount ?? pusherStatus.pending;
  const offline = syncContext?.offline ?? !pusherStatus.online;
  const lastSyncTime = syncContext?.lastSyncTime ?? null;
  const hasError = syncContext?.syncStatus === 'error';

  // 获取状态信息
  const getStatusInfo = (): {
    icon: React.ReactNode;
    tooltip: string;
    className: string;
  } => {
    if (isSyncing) {
      return {
        icon: <Loading />,
        tooltip: '正在同步...',
        className: 'sync-status--syncing',
      };
    }

    // 事件驱动推送队列积压（离线时只增不减）
    if (pendingCount > 0) {
      return {
        icon: <CloudUploadIcon />,
        tooltip: offline
          ? `离线 · ${pendingCount} 项变更待恢复在线后同步`
          : `${pendingCount} 项变更待同步`,
        className: 'sync-status--pending',
      };
    }

    if (hasError) {
      return {
        icon: <CloseCircleFilledIcon />,
        tooltip: '同步出错，点击查看',
        className: 'sync-status--error',
      };
    }

    return {
      icon: <CheckCircleFilledIcon />,
      tooltip: lastSyncTime
        ? `已同步 · ${formatRelativeTime(lastSyncTime)}`
        : '云端同步已开启',
      className: 'sync-status--synced',
    };
  };

  const statusInfo = getStatusInfo();

  return (
    <>
      <HoverTip content={statusInfo.tooltip}>
        <button
          className={`sync-status-indicator ${statusInfo.className}`}
          onClick={() => setShowSettings(true)}
          aria-label="同步设置"
        >
          {statusInfo.icon}
          {pendingCount > 0 && !isSyncing && (
            <span className="sync-status-indicator__badge">
              {pendingCount > 99 ? '99+' : pendingCount}
            </span>
          )}
        </button>
      </HoverTip>

      {showSettings && (
        <React.Suspense fallback={null}>
          <DeferredSyncSettings
            visible
            onClose={() => setShowSettings(false)}
          />
        </React.Suspense>
      )}
    </>
  );
}

/**
 * 格式化相对时间
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  if (diffDays < 7) return `${diffDays}天前`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * 同步设置面板组件（Supabase 云同步版）
 *
 * 展示：当前登录账号、同步状态、最近同步时间、手动「立即同步 / 上传本地 / 下载远程」。
 * 未登录时提示先去登录（AuthGate 已拦截未登录用户）。
 */

import React, { useCallback, useState } from 'react';
import { Dialog, MessagePlugin, Button, Loading } from 'tdesign-react';
import {
  CloudIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  HelpCircleIcon,
} from 'tdesign-icons-react';
import { useSupabaseSync } from '../../contexts/SupabaseSyncContext';
import { useConfirmDialog } from '../dialog/ConfirmDialog';
import './sync-settings.scss';
import { HoverTip } from '../shared';

/** Props */
interface SyncSettingsProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * 格式化时间
 */
function formatTime(timestamp: number | null): string {
  if (!timestamp) return '从未';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;

  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 同步设置面板
 */
export function SyncSettings({ visible, onClose }: SyncSettingsProps) {
  const {
    isConfigured,
    syncStatus,
    isSyncing,
    lastSyncTime,
    error,
    sync,
    pullFromRemote,
    pushToRemote,
  } = useSupabaseSync();

  const [isLocalSyncing, setIsLocalSyncing] = useState(false);
  const { confirm, confirmDialog } = useConfirmDialog();

  const syncingState = isSyncing || isLocalSyncing;

  // 立即同步（双向 + 媒体）
  const handleSync = useCallback(async () => {
    if (syncingState) return;
    setIsLocalSyncing(true);
    try {
      const result = await sync();
      if (result.success) {
        const parts: string[] = ['同步完成'];
        const details: string[] = [];
        if (result.uploaded > 0) details.push(`上传 ${result.uploaded} 项`);
        if (result.downloaded > 0) details.push(`下载 ${result.downloaded} 项`);
        if (result.deleted > 0) details.push(`删除 ${result.deleted} 项`);
        if (result.conflicts > 0) details.push(`合并冲突 ${result.conflicts} 项`);
        if (details.length > 0) parts.push(`(${details.join(', ')})`);
        MessagePlugin.success(parts.join(''));
      } else if (result.error && result.error !== '同步正在进行中') {
        MessagePlugin.error(result.error);
      }
    } catch (err) {
      console.error('[SyncSettings] Sync error:', err);
      MessagePlugin.error(
        '同步失败: ' + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setIsLocalSyncing(false);
    }
  }, [sync, syncingState]);

  // 以远程为准（下载）
  const handlePullFromRemote = useCallback(async () => {
    if (syncingState) return;
    const confirmed = await confirm({
      title: '确认下载覆盖',
      description: '以远程为准同步将下载云端数据覆盖本地。\n\n确定要继续吗？',
      confirmText: '继续下载',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmed) return;
    setIsLocalSyncing(true);
    try {
      const result = await pullFromRemote();
      if (result.success) {
        MessagePlugin.success(`下载完成 (${result.downloaded} 项)`);
      } else if (result.error) {
        MessagePlugin.error(result.error);
      }
    } catch (err) {
      console.error('[SyncSettings] Pull error:', err);
      MessagePlugin.error(
        '下载失败: ' + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setIsLocalSyncing(false);
    }
  }, [pullFromRemote, syncingState, confirm]);

  // 以本地为准（上传）
  const handlePushToRemote = useCallback(async () => {
    if (syncingState) return;
    const confirmed = await confirm({
      title: '确认上传覆盖',
      description: '以本地为准同步将上传本地数据覆盖云端。\n\n确定要继续吗？',
      confirmText: '继续上传',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmed) return;
    setIsLocalSyncing(true);
    try {
      const result = await pushToRemote();
      if (result.success) {
        MessagePlugin.success(`上传完成 (${result.uploaded} 项)`);
      } else if (result.error) {
        MessagePlugin.error(result.error);
      }
    } catch (err) {
      console.error('[SyncSettings] Push error:', err);
      MessagePlugin.error(
        '上传失败: ' + (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setIsLocalSyncing(false);
    }
  }, [pushToRemote, syncingState, confirm]);

  const statusText =
    syncStatus === 'synced'
      ? '已同步'
      : syncStatus === 'local_changes'
        ? '有待同步'
        : syncStatus === 'syncing'
          ? '同步中...'
          : syncStatus === 'error'
            ? '同步出错'
            : '未配置';

  return (
    <>
      <Dialog
        visible={visible}
        onClose={onClose}
        header="云端同步"
        footer={null}
        width={520}
        className="sync-settings-dialog"
      >
        <div className="sync-settings">
          {/* 顶部状态栏 */}
          <div className="sync-settings__header">
            {isConfigured ? (
              <div className="sync-settings__user-card">
                <div className="sync-settings__user-info">
                  <CloudIcon className="sync-settings__cloud-icon" />
                  <span className="sync-settings__username">
                    Supabase 账号
                  </span>
                  <span className="sync-settings__status-badge">
                    <CheckCircleFilledIcon className="sync-settings__status-icon--success" />
                    已连接
                  </span>
                </div>
              </div>
            ) : (
              <div className="sync-settings__not-connected">
                <CloudIcon className="sync-settings__cloud-icon" />
                <span>登录后自动开启云端同步</span>
              </div>
            )}
          </div>

          {/* 同步操作（已配置时显示） */}
          {isConfigured ? (
            <div className="sync-settings__sync-section">
              <div className="sync-settings__sync-stats">
                <div className="sync-settings__stat-row">
                  <span className="sync-settings__stat-label">同步状态</span>
                  <div className="sync-settings__stat-content">
                    <span className="sync-settings__stat-value">
                      {statusText}
                    </span>
                    <span className="sync-settings__stat-divider">·</span>
                    <span className="sync-settings__stat-time">
                      {formatTime(lastSyncTime)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="sync-settings__sync-actions">
                <div className="sync-settings__sync-buttons">
                  <HoverTip content="执行一次云端同步（上传 + 下载 + 媒体）">
                    <Button
                      theme="primary"
                      icon={syncingState ? <Loading /> : <CloudUploadIcon />}
                      onClick={handleSync}
                      disabled={syncingState}
                    >
                      {syncingState ? '同步中...' : '立即同步'}
                    </Button>
                  </HoverTip>
                  <HoverTip content="下载云端数据到本地（覆盖本地）">
                    <Button
                      theme="primary"
                      variant="outline"
                      icon={
                        syncingState ? <Loading /> : <CloudDownloadIcon />
                      }
                      onClick={handlePullFromRemote}
                      disabled={syncingState}
                    >
                      下载远程
                    </Button>
                  </HoverTip>
                  <HoverTip content="上传本地数据到云端（覆盖云端）">
                    <Button
                      theme="primary"
                      variant="outline"
                      icon={
                        syncingState ? <Loading /> : <CloudUploadIcon />
                      }
                      onClick={handlePushToRemote}
                      disabled={syncingState}
                    >
                      上传本地
                    </Button>
                  </HoverTip>
                </div>
              </div>

              {syncingState && (
                <div className="sync-settings__info">
                  <Loading size="small" />
                  <span>同步正在进行中</span>
                </div>
              )}

              {error && !syncingState && (
                <div className="sync-settings__error">
                  <CloseCircleFilledIcon />
                  <span>{error}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="sync-settings__not-configured">
              <HelpCircleIcon />
              <span>请先登录 Yue画布 账号以使用云端同步。</span>
            </div>
          )}

          {/* 说明 */}
          <div className="sync-settings__footer">
            <div className="sync-settings__info-block">
              <div className="sync-settings__info-header">
                <HelpCircleIcon />
                <span>同步说明</span>
              </div>
              <p>
                登录后自动将本地数据（画板、任务、提示词、工作流、知识库、聊天、
                音频、角色、素材、设置）同步到私有云端，换设备登录同一账号即可看到
                之前的记录。媒体文件存储于私有存储桶。
              </p>
            </div>
          </div>
        </div>
      </Dialog>
      {confirmDialog}
    </>
  );
}
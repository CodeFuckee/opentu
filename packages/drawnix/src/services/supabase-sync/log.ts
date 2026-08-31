/**
 * supabase-sync 日志服务（轻量）
 *
 * 复用 unified-log-service 的写入（category: 'sync'），零阻塞 fire-and-forget。
 * 与 github-sync/sync-log-service 保持同样的函数签名，便于迁移。
 */

import { unifiedLogService } from '../unified-log-service';

function write(
  level: 'debug' | 'info' | 'success' | 'warning' | 'error',
  message: string,
  data?: unknown,
  error?: Error
): void {
  try {
    unifiedLogService.log(
      'sync',
      level,
      `[supabase-sync] ${message}`,
      data ? (data as Record<string, unknown>) : undefined,
      error ? { error } : undefined
    );
  } catch {
    // 日志写入失败静默，不影响主流程
  }
}

export function logDebug(message: string, data?: unknown): void {
  write('debug', message, data);
}

export function logInfo(message: string, data?: unknown): void {
  write('info', message, data);
}

export function logSuccess(message: string, data?: unknown): void {
  write('success', message, data);
}

export function logWarning(message: string, data?: unknown): void {
  write('warning', message, data);
}

export function logError(message: string, error?: Error, data?: unknown): void {
  write('error', message, data, error);
}

export const syncLogService = {
  logDebug,
  logInfo,
  logSuccess,
  logWarning,
  logError,
};
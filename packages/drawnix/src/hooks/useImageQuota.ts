import { useCallback, useEffect, useState } from 'react';
import {
  fetchImageQuota,
  getManagedRoutingConfig,
  type ImageQuotaInfo,
} from '../services/managed-routing/managed-runtime';

export interface UseImageQuotaResult {
  /** 托管路由是否启用（未启用时 UI 不展示额度） */
  managed: boolean;
  quota: ImageQuotaInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * 查询当前登录用户本月生图额度。
 * 仅在 apps/web 注入了托管路由配置（用户已登录）时有数据；
 * 未启用时返回 managed=false，调用方可整体隐藏相关 UI。
 */
export function useImageQuota(): UseImageQuotaResult {
  const managed = Boolean(getManagedRoutingConfig());
  const [quota, setQuota] = useState<ImageQuotaInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!managed) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchImageQuota()
      .then((info) => {
        if (!cancelled) {
          setQuota(info);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '额度查询失败');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [managed, version]);

  return { managed, quota, loading, error, refresh };
}

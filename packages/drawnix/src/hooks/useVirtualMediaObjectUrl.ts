/**
 * useVirtualMediaObjectUrl
 *
 * 把虚拟媒体路径解析为媒体元素可直接使用的 URL。
 *
 * 非安全上下文（纯 HTTP 内网部署）没有 Service Worker，/asset-library/、
 * /__aitu_cache__/ 等虚拟路径不会被拦截，<video>/<audio> 直指虚拟路径必然
 * 404 —— 该场景下从 Cache Storage / IndexedDB 兜底库读取二进制并转成
 * blob URL。Service Worker 可用（由 SW 拦截回放）或非虚拟 URL
 * （外链/data:/blob:）时原样返回。
 */
import { useEffect, useRef, useState } from 'react';
import { isVirtualMediaUrl } from '../utils/virtual-media-url';
import { unifiedCacheService } from '../services/unified-cache-service';

function canServiceWorkerIntercept(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    !!navigator.serviceWorker.controller
  );
}

export function useVirtualMediaObjectUrl(
  url: string | undefined | null
): string | undefined {
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(() => {
    if (!url) return undefined;
    // 非安全上下文下虚拟路径先返回 undefined，避免闪发一次必 404 的请求
    if (isVirtualMediaUrl(url) && !canServiceWorkerIntercept()) return undefined;
    return url;
  });
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    if (!url) {
      setResolvedUrl(undefined);
      return;
    }

    if (!isVirtualMediaUrl(url) || canServiceWorkerIntercept()) {
      setResolvedUrl(url);
      return;
    }

    let cancelled = false;
    unifiedCacheService
      .getCachedBlob(url)
      .then((blob) => {
        if (cancelled) return;
        if (blob && blob.size > 0) {
          const objectUrl = URL.createObjectURL(blob);
          objectUrlRef.current = objectUrl;
          setResolvedUrl(objectUrl);
        } else {
          // 兜底库也没有二进制：保持原 URL，由元素自身错误态呈现（与既有行为一致）
          setResolvedUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) setResolvedUrl(url);
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  return resolvedUrl;
}

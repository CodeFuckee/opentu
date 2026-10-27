function isRootPathname(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html';
}

const ORIGIN_FIRST_PRELOAD_SUFFIXES = [
  '/version.json',
  '/manifest.json',
  '/sw.js',
  '/precache-manifest.json',
  '/idle-prefetch-manifest.json',
] as const;
const LAZY_CHUNK_RETRY_PARAM = '_lazy_chunk_retry';
const LAZY_CHUNK_RETRY_TS_PARAM = '_t';
const LAZY_CHUNK_RETRY_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * 同域静态子应用前缀:这些路径由独立构建的应用伺服自己的 index.html,
 * 绝不能被 app-shell 策略截胡(否则导航到子应用会拿到主应用的壳)。
 * 当前:/infinite = 嵌入的 infinite-canvas 无限画布工作台。
 */
const STATIC_SUB_APP_PREFIXES = ['/infinite'] as const;

function isStaticSubAppPathname(pathname: string): boolean {
  return STATIC_SUB_APP_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export function shouldUseAppShellStrategy(
  requestMode: string,
  pathname: string
): boolean {
  // 子应用静态路径优先排除(含 /infinite 这种目录 index,不带 .html 后缀)
  if (isStaticSubAppPathname(pathname)) {
    return false;
  }

  // 只有根壳页走 SPA fallback；目录下的 index.html 属于真实静态文档。
  if (isRootPathname(pathname)) {
    return true;
  }

  return requestMode === 'navigate' && !pathname.endsWith('.html');
}

export function shouldUseOriginFirstPreload(pathname: string): boolean {
  if (isRootPathname(pathname)) {
    return true;
  }

  return ORIGIN_FIRST_PRELOAD_SUFFIXES.some((suffix) =>
    pathname.endsWith(suffix)
  );
}

export function shouldUseCDNFirstPreload(pathname: string): boolean {
  return !shouldUseOriginFirstPreload(pathname);
}

export function shouldBypassAppShellCacheForLazyChunkRecovery(
  search: string,
  now = Date.now()
): boolean {
  const params = new URLSearchParams(search);
  if (params.get(LAZY_CHUNK_RETRY_PARAM) !== '1') {
    return false;
  }

  const retryAt = Number(params.get(LAZY_CHUNK_RETRY_TS_PARAM));
  if (!Number.isFinite(retryAt) || retryAt <= 0) {
    return true;
  }

  return now - retryAt <= LAZY_CHUNK_RETRY_MAX_AGE_MS;
}

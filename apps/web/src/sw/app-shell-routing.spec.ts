import { describe, expect, it } from 'vitest';

import {
  shouldBypassAppShellCacheForLazyChunkRecovery,
  shouldUseCDNFirstPreload,
  shouldUseOriginFirstPreload,
  shouldUseAppShellStrategy,
} from './app-shell-routing';

describe('app-shell-routing', () => {
  it('keeps SPA navigations on the app shell', () => {
    expect(shouldUseAppShellStrategy('navigate', '/workspace/abc')).toBe(true);
    expect(shouldUseAppShellStrategy('navigate', '/')).toBe(true);
    expect(shouldUseAppShellStrategy('navigate', '/index.html')).toBe(true);
  });

  it('does not treat explicit html documents as the app shell', () => {
    expect(
      shouldUseAppShellStrategy('navigate', '/user-manual/index.html')
    ).toBe(false);
    expect(
      shouldUseAppShellStrategy('navigate', '/advanced-settings.html')
    ).toBe(false);
  });

  it('routes /infinite（嵌入的无限画布工作台）to the real static app, never the shell', () => {
    expect(shouldUseAppShellStrategy('navigate', '/infinite')).toBe(false);
    expect(shouldUseAppShellStrategy('navigate', '/infinite/')).toBe(false);
    expect(shouldUseAppShellStrategy('navigate', '/infinite/#/canvas/1')).toBe(
      false
    );
    expect(
      shouldUseAppShellStrategy('navigate', '/infinite/canvas/1')
    ).toBe(false);
    // 静态资源请求本就不走 shell,一并锁定
    expect(shouldUseAppShellStrategy('script', '/infinite/assets/index.js')).toBe(
      false
    );
    // 相邻主应用路由不受前缀排除影响
    expect(shouldUseAppShellStrategy('navigate', '/infinite-tools')).toBe(true);
  });

  it('keeps only root shell and release metadata on origin-first preload', () => {
    expect(shouldUseOriginFirstPreload('/')).toBe(true);
    expect(shouldUseOriginFirstPreload('/index.html')).toBe(true);
    expect(shouldUseOriginFirstPreload('/version.json')).toBe(true);
    expect(shouldUseOriginFirstPreload('/manifest.json')).toBe(true);
    expect(shouldUseOriginFirstPreload('/sw.js')).toBe(true);
    expect(shouldUseOriginFirstPreload('/precache-manifest.json')).toBe(true);
    expect(shouldUseOriginFirstPreload('/idle-prefetch-manifest.json')).toBe(
      true
    );
  });

  it('prefers CDN for manifest-known static assets during preload', () => {
    expect(shouldUseCDNFirstPreload('/assets/index-abc123.js')).toBe(true);
    expect(shouldUseCDNFirstPreload('/icons/android-chrome-192x192.png')).toBe(
      true
    );
    expect(shouldUseCDNFirstPreload('/user-manual/index.html')).toBe(true);
  });

  it('bypasses the cached app shell only for fresh lazy chunk recovery reloads', () => {
    expect(
      shouldBypassAppShellCacheForLazyChunkRecovery(
        '?_lazy_chunk_retry=1&_t=1000',
        1000 + 60 * 1000
      )
    ).toBe(true);
    expect(
      shouldBypassAppShellCacheForLazyChunkRecovery(
        '?_lazy_chunk_retry=1&_t=1000',
        1000 + 11 * 60 * 1000
      )
    ).toBe(false);
    expect(shouldBypassAppShellCacheForLazyChunkRecovery('?board=abc')).toBe(
      false
    );
  });
});

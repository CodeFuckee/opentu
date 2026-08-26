// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCDNUrl,
  fetchFromCDNWithFallback,
  getAvailableCDNs,
  getCDNStatusReport,
  markCDNFailure,
  resetCDNStatus,
  setCDNPreference,
} from './cdn-fallback';

describe('cdn-fallback', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T00:00:00.000Z'));
    resetCDNStatus();
    await setCDNPreference(null);
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'caches', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(async () => {
    await setCDNPreference(null);
    resetCDNStatus();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses persisted preference to reorder available CDNs for the current version', async () => {
    await setCDNPreference({
      cdn: 'jsdelivr',
      latency: 18,
      timestamp: Date.now(),
      version: '1.2.3',
    });

    expect(getAvailableCDNs('1.2.3').map((item) => item.name)).toEqual([
      'jsdelivr',
    ]);
    expect(getAvailableCDNs('9.9.9').map((item) => item.name)).toEqual([
      'jsdelivr',
    ]);
  });

  it('prefers local origin first when requested for runtime assets', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://origin.example.com/')) {
          return new Response('console.log("ok");', {
            status: 200,
            headers: {
              'Content-Type': 'application/javascript',
              'Content-Length': '200',
            },
          });
        }

        return new Response('not-found', { status: 404 });
      });

    const result = await fetchFromCDNWithFallback(
      'assets/index.js',
      '2.0.0',
      'https://origin.example.com',
      { preferLocal: true }
    );

    expect(result?.source).toBe('local');
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      'https://origin.example.com/assets/index.js'
    );
  });

  it('normalizes npm-prefixed origin paths before building CDN URLs', () => {
    const [jsdelivr] = getAvailableCDNs('3.0.0');

    expect(
      buildCDNUrl(
        jsdelivr,
        '3.0.0',
        '/npm/aitu-app@3.0.0/assets/tool-drawers.css'
      )
    ).toBe('https://cdn.jsdelivr.net/npm/aitu-app@3.0.0/assets/tool-drawers.css');
  });

  it('normalizes absolute jsdelivr URLs before rebuilding fallback URLs', () => {
    const [jsdelivr] = getAvailableCDNs('3.0.0');

    expect(
      buildCDNUrl(
        jsdelivr,
        '3.0.0',
        'https://cdn.jsdelivr.net/npm/aitu-app@3.0.0/assets/tool-drawers.css'
      )
    ).toBe('https://cdn.jsdelivr.net/npm/aitu-app@3.0.0/assets/tool-drawers.css');
  });

  it('keeps third-party npm package URLs out of the aitu-app version template', () => {
    const [jsdelivr] = getAvailableCDNs('3.0.0');

    expect(
      buildCDNUrl(
        jsdelivr,
        '3.0.0',
        '/npm/winbox@0.2.82/dist/winbox.bundle.min.js'
      )
    ).toBe('https://cdn.jsdelivr.net/npm/winbox@0.2.82/dist/winbox.bundle.min.js');
  });

  it('rewrites same-origin third-party npm package paths back to jsdelivr package URLs', () => {
    const [jsdelivr] = getAvailableCDNs('3.0.0');

    expect(
      buildCDNUrl(
        jsdelivr,
        '3.0.0',
        'https://pr.opentu.ai/npm/winbox@0.2.82/dist/winbox.bundle.min.js'
      )
    ).toBe('https://cdn.jsdelivr.net/npm/winbox@0.2.82/dist/winbox.bundle.min.js');
  });

  it('uses CDN first for same-origin absolute asset URLs', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('cdn.jsdelivr.net')) {
          return new Response('console.log("cdn");', {
            status: 200,
            headers: {
              'Content-Type': 'application/javascript',
              'Content-Length': '200',
            },
          });
        }

        return new Response('origin', {
          status: 200,
          headers: {
            'Content-Type': 'application/javascript',
            'Content-Length': '200',
          },
        });
      });

    const result = await fetchFromCDNWithFallback(
      'https://pr.opentu.ai/assets/yacas-BJ4BC0dw.js',
      '3.0.0',
      'https://pr.opentu.ai'
    );

    expect(result?.source).toBe('jsdelivr');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://cdn.jsdelivr.net/npm/aitu-app@3.0.0/assets/yacas-BJ4BC0dw.js'
    );
  });

  it('falls back to jsdelivr after local miss when runtime assets enable local-first', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.startsWith('https://origin.example.com/')) {
          return new Response('missing', { status: 404 });
        }

        if (url.includes('cdn.jsdelivr.net')) {
          return new Response('body { color: black; }', {
            status: 200,
            headers: {
              'Content-Type': 'text/css',
              'Content-Length': '120',
            },
          });
        }

        return new Response('missing', { status: 404 });
      });

    const result = await fetchFromCDNWithFallback(
      'assets/index.css',
      '3.0.0',
      'https://origin.example.com',
      { preferLocal: true }
    );

    expect(result?.source).toBe('jsdelivr');
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      'https://origin.example.com/assets/index.css'
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      'https://cdn.jsdelivr.net/npm/aitu-app@3.0.0/assets/index.css'
    );
  });

  it('prefers jsdelivr before origin by default', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('cdn.jsdelivr.net')) {
          return new Response('body { color: black; }', {
            status: 200,
            headers: {
              'Content-Type': 'text/css',
              'Content-Length': '120',
            },
          });
        }

        return new Response('missing', { status: 404 });
      });

    const result = await fetchFromCDNWithFallback(
      'assets/index.css',
      '3.0.0',
      'https://origin.example.com'
    );

    expect(result?.source).toBe('jsdelivr');
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      'https://cdn.jsdelivr.net/npm/aitu-app@3.0.0/assets/index.css'
    );
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).startsWith('https://origin.example.com/')
    )).toBe(false);
  });

  it('falls back to origin when jsdelivr fails', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.startsWith('https://origin.example.com/')) {
          return new Response('body { color: black; }', {
            status: 200,
            headers: {
              'Content-Type': 'text/css',
              'Content-Length': '120',
            },
          });
        }

        return new Response('missing', { status: 404 });
      });

    const result = await fetchFromCDNWithFallback(
      'assets/index.css',
      '3.0.0',
      'https://origin.example.com'
    );

    expect(result?.source).toBe('local');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain(
      'https://origin.example.com/assets/index.css'
    );
  });

  it('drops unhealthy CDN from candidates after repeated failures', () => {
    markCDNFailure('jsdelivr', 'timeout');
    markCDNFailure('jsdelivr', 'timeout');
    markCDNFailure('jsdelivr', 'timeout');

    expect(getAvailableCDNs('1.0.0').map((item) => item.name)).toEqual([]);
  });

  it('re-enables jsdelivr after cooldown expires', () => {
    markCDNFailure('jsdelivr', 'timeout');
    markCDNFailure('jsdelivr', 'timeout');
    markCDNFailure('jsdelivr', 'timeout');

    expect(getAvailableCDNs('1.0.0').map((item) => item.name)).toEqual([]);

    vi.advanceTimersByTime(60 * 1000);
    expect(getAvailableCDNs('1.0.0').map((item) => item.name)).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(getAvailableCDNs('1.0.0').map((item) => item.name)).toEqual([
      'jsdelivr',
    ]);
  });

  it('forces a final CDN recovery probe when local origin also misses', async () => {
    markCDNFailure('jsdelivr', 'timeout');
    markCDNFailure('jsdelivr', 'timeout');
    markCDNFailure('jsdelivr', 'timeout');

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.startsWith('https://origin.example.com/')) {
          return new Response('missing', { status: 404 });
        }

        if (url.includes('cdn.jsdelivr.net')) {
          return new Response('console.log("recovered");', {
            status: 200,
            headers: {
              'Content-Type': 'application/javascript',
              'Content-Length': '180',
            },
          });
        }

        return new Response('missing', { status: 404 });
      });

    const result = await fetchFromCDNWithFallback(
      'assets/tool-windows-pGtQqqCf.js',
      '3.0.0',
      'https://origin.example.com'
    );

    expect(result?.source).toBe('jsdelivr');
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      'https://origin.example.com/assets/tool-windows-pGtQqqCf.js'
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      'https://cdn.jsdelivr.net/npm/aitu-app@3.0.0/assets/tool-windows-pGtQqqCf.js'
    );
  });

  it('still probes unhealthy CDN first during background prefetch', async () => {
    markCDNFailure('jsdelivr', 'timeout');
    markCDNFailure('jsdelivr', 'timeout');
    markCDNFailure('jsdelivr', 'timeout');

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('cdn.jsdelivr.net')) {
          return new Response('console.log("prefetch");', {
            status: 200,
            headers: {
              'Content-Type': 'application/javascript',
              'Content-Length': '220',
            },
          });
        }

        return new Response('origin', {
          status: 200,
          headers: {
            'Content-Type': 'application/javascript',
            'Content-Length': '220',
          },
        });
      });

    const result = await fetchFromCDNWithFallback(
      'assets/settings-dialog-CCOMaxX1.js',
      '3.0.0',
      'https://origin.example.com',
      {
        requestKind: 'background-prefetch',
      }
    );

    expect(result?.source).toBe('jsdelivr');
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      'https://cdn.jsdelivr.net/npm/aitu-app@3.0.0/assets/settings-dialog-CCOMaxX1.js'
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith('https://origin.example.com/')
      )
    ).toBe(false);
  });

  it('includes fail count and cooldown info in status report', () => {
    markCDNFailure('jsdelivr', 'timeout');
    markCDNFailure('jsdelivr', 'timeout');
    markCDNFailure('jsdelivr', 'timeout');

    const jsdelivrStatus = getCDNStatusReport().find(
      (item) => item.name === 'jsdelivr'
    );

    expect(jsdelivrStatus).toMatchObject({
      preferred: false,
      cooldownMs: 60 * 1000,
      cooldownUntil: Date.now() + 60 * 1000,
      remainingCooldownMs: 60 * 1000,
      status: {
        failCount: 3,
        isHealthy: false,
        lastFailureReason: 'timeout',
      },
    });
  });
});

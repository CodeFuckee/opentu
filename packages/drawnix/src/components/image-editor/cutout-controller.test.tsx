/**
 * cutout-controller 单元测试:编码会话、悬停预览节流与分层(预览层/正式层
 * 互不覆盖)、点击锁定、清空复位。
 * DOM 部分(prepareEncodePayload/buildMaskOverlayUrl)mock,纯逻辑走真实实现。
 * 注意:先用真表完成自动编码,再切 fake timers 做交互(waitFor 轮询依赖真表)。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCutoutController } from './cutout-controller';

const invokeMock = vi.fn();

vi.mock('../official-library/runtime', () => ({
  getOfficialLibraryConfig: () => ({
    client: { functions: { invoke: invokeMock } },
    supabaseUrl: 'http://sb:8021',
  }),
}));

vi.mock('./cutout-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cutout-utils')>();
  return {
    ...actual,
    prepareEncodePayload: vi.fn(() => 'aGVsbG8='),
    buildMaskOverlayUrl: vi.fn(async (_d: string, alpha = 110) => `overlay-${alpha}`),
    composeCutoutDataUrl: vi.fn(async () => 'data:image/png;base64,Zm9v'),
  };
});

const FAKE_IMG = { naturalWidth: 800, naturalHeight: 600 } as HTMLImageElement;

function segmentCalls() {
  return invokeMock.mock.calls
    .map(([, { body }]: unknown[]) => body as Record<string, unknown>)
    .filter((b) => b.action === 'segment') as Array<{
    points: number[][];
    labels: number[];
  }>;
}

async function setupReady() {
  const r = renderHook(() => useCutoutController(true, () => FAKE_IMG));
  await waitFor(() => expect(r.result.current.session?.sessionId).toBe('s-1'));
  invokeMock.mockClear();
  return r;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (_n: string, { body }: { body: Record<string, unknown> }) => {
    if (body.action === 'encode') {
      return {
        data: { sessionId: 's-1', width: 800, height: 600, device: 'cuda', encodeMs: 10 },
        error: null,
      };
    }
    return {
      data: { maskPngB64: 'aW1n', score: 0.9, maskWidth: 8, maskHeight: 6, decodeMs: 5 },
      error: null,
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCutoutController', () => {
  it('enabled 即自动编码', async () => {
    const { result } = await setupReady();
    expect(result.current.session?.device).toBe('cuda');
  });

  it('悬停预览:间隔+距离节流;预览只写悬停层', async () => {
    const { result } = await setupReady();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

    act(() => result.current.hoverMove(100, 100));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(segmentCalls()).toHaveLength(1);
    expect(segmentCalls()[0].points).toEqual([[100, 100]]);
    expect(result.current.hoverOverlayUrl).toBe('overlay-70');
    expect(result.current.maskOverlayUrl).toBeNull();

    // 间隔内 + 距离足够 → 节流丢弃
    act(() => result.current.hoverMove(300, 300));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(segmentCalls()).toHaveLength(1);

    // 超间隔 + 超距离 → 再发
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.hoverMove(300, 300));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(segmentCalls()).toHaveLength(2);
  });

  it('悬停移出:清预览层', async () => {
    const { result } = await setupReady();
    act(() => result.current.hoverMove(100, 100));
    await waitFor(() => expect(result.current.hoverOverlayUrl).toBe('overlay-70'));
    act(() => result.current.hoverLeave());
    expect(result.current.hoverOverlayUrl).toBeNull();
  });

  it('点击:立即清预览层,防抖后正式分割写正式层', async () => {
    const { result } = await setupReady();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

    act(() => result.current.hoverMove(100, 100));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(result.current.hoverOverlayUrl).toBe('overlay-70');

    act(() => result.current.addPoint(1, 120, 130));
    expect(result.current.hoverOverlayUrl).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    // 调用顺序:①悬停预览 [100,100] ②点击正式 [120,130]
    const calls = segmentCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].points).toEqual([[120, 130]]);
    expect(result.current.maskOverlayUrl).toBe('overlay-110');
    expect(result.current.score).toBe(0.9);
  });

  it('清空:复位点集与正式层', async () => {
    const { result } = await setupReady();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    act(() => result.current.addPoint(1, 10, 10));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(result.current.maskOverlayUrl).toBe('overlay-110');
    act(() => result.current.clearPoints());
    expect(result.current.points).toEqual([]);
    expect(result.current.maskOverlayUrl).toBeNull();
    expect(result.current.score).toBeNull();
  });
});

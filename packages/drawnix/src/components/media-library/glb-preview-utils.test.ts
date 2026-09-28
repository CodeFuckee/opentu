import { describe, expect, it } from 'vitest';
import {
  advanceProgress,
  GLB_LARGE_FILE_BYTES,
  GLB_PROGRESS_STALL_MS,
  isProgressStalled,
  shouldPromptLargeFile,
} from './glb-preview-utils';

describe('shouldPromptLargeFile', () => {
  it('未知/缺失体积不提示(降级为加载中观察)', () => {
    expect(shouldPromptLargeFile(undefined)).toBe(false);
    expect(shouldPromptLargeFile(null)).toBe(false);
  });

  it('阈值内(含恰好等于)不提示', () => {
    expect(shouldPromptLargeFile(0)).toBe(false);
    expect(shouldPromptLargeFile(4.3 * 1024 * 1024)).toBe(false);
    expect(shouldPromptLargeFile(GLB_LARGE_FILE_BYTES)).toBe(false);
  });

  it('超过 20MB 提示(覆盖生产最大 ~45MB 样本)', () => {
    expect(shouldPromptLargeFile(GLB_LARGE_FILE_BYTES + 1)).toBe(true);
    expect(shouldPromptLargeFile(45.1 * 1024 * 1024)).toBe(true);
  });
});

describe('advanceProgress', () => {
  const t0 = 1_000_000;

  it('进度增长时刷新百分比与推进时钟', () => {
    const next = advanceProgress({ progress: 10, lastAdvancedAt: t0 }, 55, t0 + 1000);
    expect(next).toEqual({ progress: 55, lastAdvancedAt: t0 + 1000 });
  });

  it('停滞的重复/回退上报不重置看门狗时钟', () => {
    const state = { progress: 55, lastAdvancedAt: t0 };
    expect(advanceProgress(state, 55, t0 + 9000)).toBe(state);
    expect(advanceProgress(state, 30, t0 + 9000)).toBe(state);
  });

  it('百分比钳制到 0-100 并四舍五入', () => {
    expect(advanceProgress({ progress: 0, lastAdvancedAt: t0 }, -5, t0).progress).toBe(0);
    expect(advanceProgress({ progress: 90, lastAdvancedAt: t0 }, 150, t0).progress).toBe(100);
    expect(advanceProgress({ progress: 0, lastAdvancedAt: t0 }, 33.4, t0).progress).toBe(33);
  });
});

describe('isProgressStalled', () => {
  const t0 = 2_000_000;

  it('进度未到 100 且超过停滞窗口判超时', () => {
    expect(
      isProgressStalled({ progress: 40, lastAdvancedAt: t0 }, t0 + GLB_PROGRESS_STALL_MS + 1)
    ).toBe(true);
  });

  it('窗口内不算停滞', () => {
    expect(
      isProgressStalled({ progress: 40, lastAdvancedAt: t0 }, t0 + GLB_PROGRESS_STALL_MS)
    ).toBe(false);
  });

  it('进度到 100 后永不判停滞(等待 load 事件兜底)', () => {
    expect(
      isProgressStalled({ progress: 100, lastAdvancedAt: t0 }, t0 + GLB_PROGRESS_STALL_MS * 10)
    ).toBe(false);
  });
});

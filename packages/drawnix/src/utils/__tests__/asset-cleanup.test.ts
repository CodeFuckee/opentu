import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleVirtualUrlImageError, clearVirtualUrlImageError } from '../asset-cleanup';

// mock unified-cache-service 的 getCachedBlob
const { getCachedBlobMock } = vi.hoisted(() => ({
  getCachedBlobMock: vi.fn(),
}));

vi.mock('../../services/unified-cache-service', () => ({
  unifiedCacheService: {
    getCachedBlob: getCachedBlobMock,
  },
}));

function createBoard() {
  return {
    __plait_id: 'board-test',
    children: [],
  } as any;
}

function createImageElement(url: string) {
  return { id: 'element-1', url } as any;
}

describe('handleVirtualUrlImageError - 虚拟 URL 图片加载失败兜底', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCachedBlobMock.mockReset();
  });

  it('重试未耗尽时返回重试 URL（不立即删除元素）', () => {
    const board = createBoard();
    const element = createImageElement('/asset-library/content-abc.png');

    const retry1 = handleVirtualUrlImageError(board, element, '/asset-library/content-abc.png');
    expect(retry1).toBeDefined();
    expect(retry1!.retryUrl).toContain('_retry=');
    expect(getCachedBlobMock).not.toHaveBeenCalled();
  });

  it('兜底能力: 重试耗尽后若 Cache Storage 中存在 blob，应通过回调把 blob 暴露给组件用于 objectURL 兜底展示', async () => {
    const board = createBoard();
    const element = createImageElement('/asset-library/content-abc.png');
    const onCachedBlob = vi.fn();

    getCachedBlobMock.mockResolvedValue(
      new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    );

    // 触发完整重试序列（默认 VIRTUAL_IMAGE_ERROR_RETRY_DELAYS 为 3 次），
    // 第 4 次调用应进入缓存核验分支（第 4 参数为 options 对象）
    handleVirtualUrlImageError(board, element, '/asset-library/content-abc.png', { onCachedBlob } as any);
    handleVirtualUrlImageError(board, element, '/asset-library/content-abc.png', { onCachedBlob } as any);
    handleVirtualUrlImageError(board, element, '/asset-library/content-abc.png', { onCachedBlob } as any);
    const retry4 = handleVirtualUrlImageError(board, element, '/asset-library/content-abc.png', { onCachedBlob } as any);
    expect(retry4).toBeUndefined();

    // 等待异步缓存核验完成
    await vi.waitFor(() => {
      expect(getCachedBlobMock).toHaveBeenCalled();
    });

    // 核心断言：缓存中有原始数据时，必须把 blob 交给组件做兜底展示，
    // 否则画布上的图片永远是空白（visibility:hidden），数据白白存在 Cache 而无人消费
    await vi.waitFor(() => {
      expect(onCachedBlob).toHaveBeenCalledTimes(1);
    });
    const blobArg = onCachedBlob.mock.calls[0][0] as Blob;
    expect(blobArg.type).toBe('image/png');
    expect(blobArg.size).toBeGreaterThan(0);
  });

  it('首次失败开启 verifyCacheImmediately 时立即回调 blob（SW 未接管场景优先走缓存兜底）', async () => {
    const board = createBoard();
    const element = createImageElement('/asset-library/content-abc.png');
    const onCachedBlob = vi.fn();

    getCachedBlobMock.mockResolvedValue(
      new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    );

    handleVirtualUrlImageError(board, element, '/asset-library/content-abc.png', {
      onCachedBlob,
      verifyCacheImmediately: true,
    } as any);

    // 首次失败即异步核验缓存并回调 blob
    await vi.waitFor(() => {
      expect(onCachedBlob).toHaveBeenCalledTimes(1);
    });
  });

  it('缓存中不存在数据时不提供兜底 blob（组件将删除元素）', async () => {
    const board = createBoard();
    const element = createImageElement('/asset-library/content-missing.png');
    const onCachedBlob = vi.fn();

    getCachedBlobMock.mockResolvedValue(null);

    for (let i = 0; i < 4; i++) {
      handleVirtualUrlImageError(board, element, '/asset-library/content-missing.png', { onCachedBlob } as any);
    }

    // 异步缓存核验应执行，但不应产生兜底 blob
    await vi.waitFor(() => {
      expect(getCachedBlobMock).toHaveBeenCalled();
    });
    expect(onCachedBlob).not.toHaveBeenCalled();
  });

  it('clearVirtualUrlImageError 重置重试计数', () => {
    const board = createBoard();
    const element = createImageElement('/asset-library/content-abc.png');
    const url = '/asset-library/content-abc.png';

    handleVirtualUrlImageError(board, element, url);
    clearVirtualUrlImageError(board, element, url);

    // 清空后重试计数从 0 开始：下一次调用返回第一个重试 URL
    const retry = handleVirtualUrlImageError(board, element, url);
    expect(retry).toBeDefined();
  });
});
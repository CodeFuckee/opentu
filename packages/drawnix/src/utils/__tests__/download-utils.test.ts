import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetSource, AssetType, type Asset } from '../../types/asset.types';
import { TaskStatus, TaskType, type Task } from '../../types/task.types';
import type { AudioDownloadMetadata } from '../audio-id3';

import {
  buildAssetDownloadItem,
  buildTaskDownloadItems,
  smartDownload,
} from '../download-utils';

const {
  downloadFileMock,
  openInNewTabMock,
  downloadFromBlobMock,
  applyAudioMetadataToBlobMock,
} = vi.hoisted(() => ({
  downloadFileMock: vi.fn<(url: string, filename?: string) => Promise<void>>(),
  openInNewTabMock: vi.fn<(url: string) => void>(),
  downloadFromBlobMock: vi.fn<(blob: Blob, filename: string) => void>(),
  applyAudioMetadataToBlobMock: vi.fn<
    (
      sourceBlob: Blob,
      metadata?: AudioDownloadMetadata,
      sourceUrl?: string
    ) => Promise<Blob>
  >(),
}));

vi.mock('@aitu/utils', async () => {
  const actual = await vi.importActual<typeof import('@aitu/utils')>('@aitu/utils');
  return {
    ...actual,
    downloadFile: downloadFileMock,
    openInNewTab: openInNewTabMock,
    downloadFromBlob: downloadFromBlobMock,
  };
});

vi.mock('../audio-id3', () => ({
  applyAudioMetadataToBlob: applyAudioMetadataToBlobMock,
}));

function createAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    type: AssetType.AUDIO,
    source: AssetSource.AI_GENERATED,
    url: '/asset-library/audio/demo-track.mp3',
    name: 'demo-track',
    mimeType: 'audio/mpeg',
    createdAt: 1,
    ...overrides,
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    type: TaskType.AUDIO,
    status: TaskStatus.COMPLETED,
    params: {
      prompt: '写一首轻快电子乐',
      title: '电子乐',
      tags: 'electronic,pop',
      model: 'suno-v4',
    },
    createdAt: 1,
    updatedAt: 1,
    result: {
      url: '/__aitu_cache__/audio/task-1_0.mp3',
      urls: [
        '/__aitu_cache__/audio/task-1_0.mp3',
        '/__aitu_cache__/audio/task-1_1.mp3',
      ],
      format: 'mp3',
      size: 0,
      previewImageUrl: '/__aitu_cache__/image/task-1-cover.png',
      title: '电子乐',
      clips: [
        {
          audioUrl: '/__aitu_cache__/audio/task-1_0.mp3',
          title: 'clip-1',
          imageLargeUrl: '/__aitu_cache__/image/task-1-cover_0.png',
        },
        {
          audioUrl: '/__aitu_cache__/audio/task-1_1.mp3',
          title: 'clip-2',
        },
      ],
    },
    ...overrides,
  };
}

describe('download-utils', () => {
  beforeEach(() => {
    downloadFileMock.mockReset();
    openInNewTabMock.mockReset();
    downloadFromBlobMock.mockReset();
    applyAudioMetadataToBlobMock.mockReset();
    applyAudioMetadataToBlobMock.mockImplementation(async (blob) => blob);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('为素材库音频构建带封面的下载项', () => {
    const item = buildAssetDownloadItem(
      createAsset({
        thumbnail: '/covers/asset-cover.png',
        prompt: '舒缓钢琴曲',
        modelName: 'suno-v4',
      })
    );

    expect(item.type).toBe('audio');
    expect(item.filename).toBe('demo-track.mp3');
    expect(item.audioMetadata).toMatchObject({
      title: 'demo-track',
      prompt: '舒缓钢琴曲',
      coverUrl: '/covers/asset-cover.png',
      artist: 'suno-v4',
      album: 'Aitu Generated',
    });
  });

  it('为多 clip 任务下载项保留每条音频的封面回退', () => {
    const items = buildTaskDownloadItems(createTask());

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      filename: 'clip-1-1.mp3',
      audioMetadata: {
        coverUrl: '/__aitu_cache__/image/task-1-cover_0.png',
      },
    });
    expect(items[1]).toMatchObject({
      filename: 'clip-2-2.mp3',
      audioMetadata: {
        coverUrl: '/__aitu_cache__/image/task-1-cover.png',
      },
    });
  });

  it('单文件跨域抓取失败时改为打开链接', async () => {
    downloadFileMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const result = await smartDownload([
      {
        url: 'https://cdn.example.com/image.png',
        type: 'image',
        filename: 'image.png',
      },
    ]);

    expect(openInNewTabMock).toHaveBeenCalledWith(
      'https://cdn.example.com/image.png'
    );
    expect(result).toEqual({
      openedCount: 1,
      downloadedCount: 0,
      failedCount: 0,
    });
  });

  it('单音频跨域抓取失败时改为打开链接', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    );

    const result = await smartDownload([
      {
        url: 'https://cdn.example.com/audio.mp3',
        type: 'audio',
        filename: 'audio.mp3',
      },
    ]);

    expect(openInNewTabMock).toHaveBeenCalledWith(
      'https://cdn.example.com/audio.mp3'
    );
    expect(downloadFromBlobMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      openedCount: 1,
      downloadedCount: 0,
      failedCount: 0,
    });
  });

});

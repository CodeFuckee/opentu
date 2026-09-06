import {
  canvasAudioPlaybackService,
  type CanvasAudioPlaybackSource,
  isReadingPlaybackSource,
} from './canvas-audio-playback-service';
import { MUSIC_PLAYER_TOOL_ID } from '../tools/tool-ids';
import type { ToolDefinition } from '../types/toolbox.types';
import type { ReadingPlaybackSource } from './reading-playback-source';
// 静态导入 toolWindowService：该单例由懒加载运行时提供，但这里改静态导入以
// 打破 ai-chat ↔ tool-windows 之间的动态 chunk 环（动态环会导致生产构建里
// tool-windows chunk 顶层模块初始化顺序错乱，报 "reading 'isHotkey' of
// undefined"，应用启动即失败）。调用都在函数内，静态导入不改变行为。
import { toolWindowService } from './tool-window-service';

type MusicPlayerSource = CanvasAudioPlaybackSource | ReadingPlaybackSource;

export async function openMusicPlayerTool(): Promise<boolean> {
  const tool: ToolDefinition = {
    id: MUSIC_PLAYER_TOOL_ID,
    name: '音乐播放器',
    description: '从素材库选择音频并后台播放，可与画布播放控件联动',
    icon: '🎵',
    category: 'utilities',
    component: 'music-player',
    defaultWidth: 420,
    defaultHeight: 640,
  };

  toolWindowService.openTool(tool, { autoPin: true });
  return true;
}

interface OpenMusicPlayerAndPlayOptions {
  source: MusicPlayerSource;
  queue?: MusicPlayerSource[];
  playlist?: {
    playlistId: string;
    playlistName: string;
  };
  queueTab?: {
    queueId: string;
    queueName: string;
  };
}

export async function openMusicPlayerToolAndPlay(
  options: OpenMusicPlayerAndPlayOptions
): Promise<boolean> {
  await openMusicPlayerTool();

  if (options.queue && options.queue.length > 0) {
    if (options.queue.every((item) => isReadingPlaybackSource(item))) {
      canvasAudioPlaybackService.setReadingQueue(options.queue as ReadingPlaybackSource[], {
        queueId: options.queueTab?.queueId,
        queueName: options.queueTab?.queueName,
      });
    } else {
      canvasAudioPlaybackService.setQueue(
        options.queue as CanvasAudioPlaybackSource[],
        {
          queueSource: options.playlist ? 'playlist' : 'canvas',
          playlistId: options.playlist?.playlistId,
          playlistName: options.playlist?.playlistName,
          queueId: options.queueTab?.queueId,
          queueName: options.queueTab?.queueName,
        }
      );
    }
  }

  if (isReadingPlaybackSource(options.source)) {
    canvasAudioPlaybackService.toggleReadingPlayback(options.source);
  } else {
    await canvasAudioPlaybackService.togglePlayback(options.source);
  }
  return true;
}

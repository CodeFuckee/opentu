/**
 * Video Model Configuration
 *
 * Defines supported video models and their parameter options.
 * This configuration drives the UI for video generation.
 */

import type {
  DurationOption,
  ImageUploadConfig,
  SizeOption,
  VideoModel,
  VideoModelConfig,
} from '../types/video.types';
import { getModelConfig, ModelVendor } from './model-config';

const SEEDANCE_ASPECT_RATIO_OPTIONS = [
  { label: '横屏 16:9', aspectRatio: '16:9' },
  { label: '竖屏 9:16', aspectRatio: '9:16' },
  { label: '方形 1:1', aspectRatio: '1:1' },
] as const;

const SEEDANCE_RESOLUTION_OPTIONS = ['1080p', '720p', '480p'] as const;

const SEEDANCE_SIZE_OPTIONS: SizeOption[] = SEEDANCE_RESOLUTION_OPTIONS.flatMap(
  (resolution) =>
    SEEDANCE_ASPECT_RATIO_OPTIONS.map(({ label, aspectRatio }) => ({
      label: `${resolution} · ${label}`,
      value: `${resolution}@${aspectRatio}`,
      aspectRatio,
    }))
);

/**
 * MiniMax H3 本地网关的像素预算约 0.52MP（16G 共享显存保守值，超预算自动等比缩小），
 * 分辨率档只到 720p，1080p 会被网关缩回，不提供该档。
 */
const MINIMAX_H3_RESOLUTION_OPTIONS = ['720p', '480p'] as const;

const MINIMAX_H3_SIZE_OPTIONS: SizeOption[] =
  MINIMAX_H3_RESOLUTION_OPTIONS.flatMap((resolution) =>
    SEEDANCE_ASPECT_RATIO_OPTIONS.map(({ label, aspectRatio }) => ({
      label: `${resolution} · ${label}`,
      value: `${resolution}@${aspectRatio}`,
      aspectRatio,
    }))
  );



/**
 * Video model configurations
 * Each model has specific duration, size, and image upload options
 */
export const VIDEO_MODEL_CONFIGS: Record<string, VideoModelConfig> = {
  // Seedance models
  'seedance-2.5-pro': {
    id: 'seedance-2.5-pro',
    label: 'Seedance 2.5 Pro',
    provider: 'seedance',
    description: '即梦 2.5 有声视频，支持首尾帧',
    durationOptions: [
      { label: '5秒', value: '5' },
      { label: '10秒', value: '10' },
    ],
    defaultDuration: '5',
    sizeOptions: SEEDANCE_SIZE_OPTIONS,
    defaultSize: '720p@16:9',
    imageUpload: {
      maxCount: 2,
      mode: 'frames',
      labels: ['首帧', '尾帧'],
    },
  },
  'seedance-1.5-pro': {
    id: 'seedance-1.5-pro',
    label: 'Seedance 1.5 Pro',
    provider: 'seedance',
    description: '即梦 1.5 Pro 有声视频，支持首尾帧',
    durationOptions: [
      { label: '5秒', value: '5' },
      { label: '10秒', value: '10' },
    ],
    defaultDuration: '5',
    sizeOptions: SEEDANCE_SIZE_OPTIONS,
    defaultSize: '720p@16:9',
    imageUpload: {
      maxCount: 2,
      mode: 'frames',
      labels: ['首帧', '尾帧'],
    },
  },
  'seedance-1.0-pro': {
    id: 'seedance-1.0-pro',
    label: 'Seedance 1.0 Pro',
    provider: 'seedance',
    description: '即梦 1.0 Pro，支持首尾帧',
    durationOptions: [
      { label: '5秒', value: '5' },
      { label: '10秒', value: '10' },
    ],
    defaultDuration: '5',
    sizeOptions: SEEDANCE_SIZE_OPTIONS,
    defaultSize: '720p@16:9',
    imageUpload: {
      maxCount: 2,
      mode: 'frames',
      labels: ['首帧', '尾帧'],
    },
  },
  'seedance-1.0-pro-fast': {
    id: 'seedance-1.0-pro-fast',
    label: 'Seedance 1.0 Fast',
    provider: 'seedance',
    description: '即梦 1.0 快速模式，仅首帧',
    durationOptions: [
      { label: '5秒', value: '5' },
      { label: '10秒', value: '10' },
    ],
    defaultDuration: '5',
    sizeOptions: SEEDANCE_SIZE_OPTIONS,
    defaultSize: '720p@16:9',
    imageUpload: {
      maxCount: 1,
      mode: 'frames',
      labels: ['首帧'],
    },
  },
  'seedance-1.0-lite': {
    id: 'seedance-1.0-lite',
    label: 'Seedance 1.0 Lite',
    provider: 'seedance',
    description: '即梦 1.0 Lite，支持首尾帧和参考图',
    durationOptions: [
      { label: '5秒', value: '5' },
      { label: '10秒', value: '10' },
    ],
    defaultDuration: '5',
    sizeOptions: SEEDANCE_SIZE_OPTIONS,
    defaultSize: '720p@16:9',
    imageUpload: {
      maxCount: 4,
      mode: 'reference',
      labels: ['首帧', '尾帧', '参考图1', '参考图2'],
    },
  },

  // MiniMax H3（服务器本地部署网关，见 ~/h3-video/，Ref2VA 最多 9 张参考图）
  'minimax-h3': {
    id: 'minimax-h3',
    label: 'MiniMax H3（本地）',
    provider: 'minimax',
    description: '本地部署 MiniMax H3，支持多参考图与音频',
    durationOptions: [
      { label: '5秒', value: '5' },
      { label: '10秒', value: '10' },
    ],
    defaultDuration: '5',
    sizeOptions: MINIMAX_H3_SIZE_OPTIONS,
    defaultSize: '720p@16:9',
    imageUpload: {
      maxCount: 9,
      mode: 'reference',
      labels: ['参考图'],
    },
  },

};

/**
 * Normalize model name to a known config key; fallback to默认模型（即梦 2.5）避免崩溃。
 */
export function normalizeVideoModel(model?: string | null): VideoModel {
  if (model) {
    return model;
  }
  return 'seedance-2.5-pro';
}

/**
 * 已下架视频模型家族（2026-11-03 运营决策：gemini/veo/kling/happyhorse 视频模型
 * 全部下架，仅保留 seedance 系）。云端目录、静态配置、运行时发现三条来源均已
 * 移除，此判定作为下拉出口的硬过滤，防止老设置/钉住逻辑让它们复活进下拉。
 */
export function isRemovedVideoModelFamily(modelId: string): boolean {
  return /^(kling|veo|omni-flash|happyhorse)/i.test(modelId || '');
}

function isStandardKlingVideoModel(modelId: string): boolean {
  const lowerId = modelId.toLowerCase();
  return lowerId === 'kling_video' || /^kling-v\d(?:[-.]\d+)?$/.test(lowerId);
}

function buildStandardKlingVideoConfig(
  modelId: string,
  runtimeConfig?: ReturnType<typeof getModelConfig>
): VideoModelConfig {
  const capabilityConfig = VIDEO_MODEL_CONFIGS.kling_video;
  const isCapabilityModel = modelId.toLowerCase() === 'kling_video';

  return {
    ...capabilityConfig,
    id: modelId,
    label:
      runtimeConfig?.shortLabel ||
      runtimeConfig?.label ||
      capabilityConfig.label,
    description: isCapabilityModel
      ? runtimeConfig?.description || capabilityConfig.description
      : runtimeConfig?.description ||
        'Kling 标准视频版本，支持文生视频和图生视频',
  };
}

function getConfigOrDefault(model?: string | null): VideoModelConfig {
  const normalized = normalizeVideoModel(model);
  const builtInConfig = VIDEO_MODEL_CONFIGS[normalized];
  if (builtInConfig) {
    return builtInConfig;
  }

  const runtimeConfig = getModelConfig(normalized);
  if (isStandardKlingVideoModel(normalized)) {
    return buildStandardKlingVideoConfig(normalized, runtimeConfig);
  }

  const defaultSize = runtimeConfig?.videoDefaults?.size || '1280x720';
  const defaultAspectRatio =
    runtimeConfig?.videoDefaults?.aspectRatio || '16:9';
  const defaultDuration = runtimeConfig?.videoDefaults?.duration || '8';
  const lowerId = normalized.toLowerCase();

  const sizeOptions: SizeOption[] = [
    {
      label: defaultAspectRatio,
      value: defaultSize,
      aspectRatio: defaultAspectRatio,
    },
  ];

  if (defaultSize !== '1280x720') {
    sizeOptions.push({
      label: '横屏 16:9',
      value: '1280x720',
      aspectRatio: '16:9',
    });
  }
  if (defaultSize !== '720x1280') {
    sizeOptions.push({
      label: '竖屏 9:16',
      value: '720x1280',
      aspectRatio: '9:16',
    });
  }

  const durationOptions: DurationOption[] = [
    { label: `${defaultDuration}秒`, value: defaultDuration },
  ];
  const imageUpload: ImageUploadConfig = lowerId.includes('components')
    ? {
        maxCount: 3,
        mode: 'components',
        labels: ['参考图1', '参考图2', '参考图3'],
      }
    : lowerId.includes('frame')
    ? { maxCount: 2, mode: 'frames', labels: ['首帧', '尾帧'] }
    : { maxCount: 1, mode: 'reference', labels: ['参考图'] };

  const provider =
    runtimeConfig?.vendor === ModelVendor.SORA
      ? 'sora'
      : runtimeConfig?.vendor === ModelVendor.KLING
      ? 'kling'
      : lowerId.includes('seedance')
      ? 'seedance'
      : lowerId.includes('happyhorse')
      ? 'happyhorse'
      : 'veo';

  return {
    id: normalized,
    label: runtimeConfig?.shortLabel || runtimeConfig?.label || normalized,
    provider,
    description: runtimeConfig?.description || '运行时发现的视频模型',
    durationOptions,
    defaultDuration,
    sizeOptions,
    defaultSize,
    imageUpload,
  };
}

/**
 * Get model configuration by model ID
 */
export function getVideoModelConfig(model: VideoModel): VideoModelConfig {
  return getConfigOrDefault(model);
}

/**
 * Get all video model options for select component
 */
export function getVideoModelOptions(): { label: string; value: VideoModel }[] {
  return Object.values(VIDEO_MODEL_CONFIGS).map((config) => ({
    label: config.label,
    value: config.id,
  }));
}

/**
 * Get default parameters for a model
 */
export function getDefaultModelParams(model: VideoModel): {
  duration: string;
  size: string;
} {
  const config = getConfigOrDefault(model);
  return {
    duration: config.defaultDuration,
    size: config.defaultSize,
  };
}

function normalizeVideoAspectRatio(
  aspectRatio?: string | null
): string | undefined {
  const normalized = aspectRatio?.trim().replace(/[xX]/g, ':');
  return normalized && /^\d+:\d+$/.test(normalized) ? normalized : undefined;
}

/**
 * 获取模型下可安全使用的视频尺寸。
 * 若传入尺寸为空或不受当前模型支持，则回退到模型默认尺寸。
 */
export function getValidVideoSize(
  model: VideoModel,
  size?: string | null,
  aspectRatio?: string | null
): string {
  const config = getConfigOrDefault(model);
  if (size && config.sizeOptions.some((option) => option.value === size)) {
    return size;
  }
  const normalizedAspectRatio = normalizeVideoAspectRatio(aspectRatio);
  const legacyResolution = size && /^\d+p$/.test(size) ? size : undefined;

  if (legacyResolution) {
    const resolutionMatch = config.sizeOptions.find(
      (option) =>
        option.value.startsWith(`${legacyResolution}@`) &&
        (!normalizedAspectRatio || option.aspectRatio === normalizedAspectRatio)
    );
    if (resolutionMatch) {
      return resolutionMatch.value;
    }
  }

  if (normalizedAspectRatio) {
    const aspectRatioMatch = config.sizeOptions.find(
      (option) => option.aspectRatio === normalizedAspectRatio
    );
    if (aspectRatioMatch) {
      return aspectRatioMatch.value;
    }
  }

  return config.defaultSize;
}

/**
 * Check if model supports multiple image uploads
 */
export function supportsMultipleImages(model: VideoModel): boolean {
  const config = getConfigOrDefault(model);
  return config.imageUpload.maxCount > 1;
}

/**
 * Get image upload labels for a model
 */
export function getImageUploadLabels(model: VideoModel): string[] {
  const config = getConfigOrDefault(model);
  return config.imageUpload.labels || ['参考图'];
}

/**
 * Check if model supports storyboard mode
 */
export function supportsStoryboardMode(model: VideoModel): boolean {
  const config = getConfigOrDefault(model);
  return config.storyboardMode?.supported ?? false;
}

/**
 * Get storyboard mode configuration for a model
 */
export function getStoryboardModeConfig(model: VideoModel) {
  const config = getConfigOrDefault(model);
  return (
    config.storyboardMode ?? {
      supported: false,
      maxScenes: 15,
      minSceneDuration: 0.1,
    }
  );
}

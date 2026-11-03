/**
 * 视频模型下架过滤单测（2026-11-03 运营决策：gemini/veo/kling/happyhorse 全部下架）
 *
 * 覆盖：
 * - isRemovedVideoModelFamily 对四家各形态 ID 的识别与 seedance/sora 放行
 * - VIDEO_MODEL_CONFIGS 静态目录已无四家条目且 seedance-2.5-pro 在位
 * - 默认模型不是已下架家族
 */
import { describe, expect, it } from 'vitest';
import {
  VIDEO_MODEL_CONFIGS,
  isRemovedVideoModelFamily,
} from '../video-model-config';
import { DEFAULT_VIDEO_MODEL_ID } from '../model-config';

describe('isRemovedVideoModelFamily', () => {
  it('识别 kling 系', () => {
    expect(isRemovedVideoModelFamily('kling_video')).toBe(true);
    expect(isRemovedVideoModelFamily('kling-v1-6')).toBe(true);
    expect(isRemovedVideoModelFamily('kling-video-o1')).toBe(true);
  });

  it('识别 veo/omni-flash 系', () => {
    expect(isRemovedVideoModelFamily('veo3')).toBe(true);
    expect(isRemovedVideoModelFamily('veo3.1-components-4k')).toBe(true);
    expect(isRemovedVideoModelFamily('omni-flash')).toBe(true);
    expect(isRemovedVideoModelFamily('omni-flash-components')).toBe(true);
  });

  it('识别 happyhorse 系', () => {
    expect(isRemovedVideoModelFamily('happyhorse-1.0-t2v')).toBe(true);
    expect(isRemovedVideoModelFamily('happyhorse-1.0-video-edit')).toBe(true);
  });

  it('seedance/sora 放行', () => {
    expect(isRemovedVideoModelFamily('seedance-2.5-pro')).toBe(false);
    expect(isRemovedVideoModelFamily('seedance-1.0-lite')).toBe(false);
    expect(isRemovedVideoModelFamily('sora-2')).toBe(false);
  });
});

describe('VIDEO_MODEL_CONFIGS 下架后状态', () => {
  it('不含四家条目', () => {
    for (const id of Object.keys(VIDEO_MODEL_CONFIGS)) {
      expect(isRemovedVideoModelFamily(id)).toBe(false);
    }
  });

  it('seedance 系在位', () => {
    expect(VIDEO_MODEL_CONFIGS['seedance-2.5-pro']).toBeTruthy();
    expect(VIDEO_MODEL_CONFIGS['seedance-1.5-pro']).toBeTruthy();
  });

  it('默认模型不是已下架家族', () => {
    expect(isRemovedVideoModelFamily(DEFAULT_VIDEO_MODEL_ID)).toBe(false);
  });
});

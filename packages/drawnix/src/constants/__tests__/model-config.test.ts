import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRuntimeModelConfigs,
  getCompatibleParams,
  getSizeOptionsForModel,
  getStaticModelConfig,
  ModelVendor,
  setRuntimeModelConfigs,
} from '../model-config';

describe('model-config image size options', () => {
  afterEach(() => {
    clearRuntimeModelConfigs();
  });

  it('为 gpt-image-2 系列暴露扩展比例', () => {
    const expected = [
      'auto',
      '1x1',
      '2x3',
      '3x2',
      '3x4',
      '4x3',
      '4x5',
      '5x4',
      '9x16',
      '16x9',
      '21x9',
    ];

    expect(
      getSizeOptionsForModel('gpt-image-2').map((option) => option.value)
    ).toEqual(expected);
    expect(
      getSizeOptionsForModel('gpt-image-2-vip').map((option) => option.value)
    ).toEqual(expected);
  });

  it('为 gpt-image-2 暴露分辨率和官方画质参数', () => {
    const params = getCompatibleParams('gpt-image-2');
    const qualityParams = params.filter((param) => param.id === 'quality');

    expect(
      params
        .find((param) => param.id === 'resolution')
        ?.options?.map((option) => option.value)
    ).toEqual(['1k', '2k', '4k']);
    expect(qualityParams).toHaveLength(1);
    expect(qualityParams[0]?.options?.map((option) => option.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
    ]);
  });

  it('不再内置已下架的 GPT Image 旧模型', () => {
    expect(getStaticModelConfig('gpt-image-1')).toBeUndefined();
    expect(getStaticModelConfig('gpt-image-1.5')).toBeUndefined();
    expect(getCompatibleParams('gpt-image-1')).toEqual([]);
    expect(getCompatibleParams('gpt-image-1.5')).toEqual([]);
  });

  it('保留 Gemini preview 的旧 quality 档位参数', () => {
    const params = getCompatibleParams('gemini-3-pro-image-preview');
    const qualityParams = params.filter((param) => param.id === 'quality');

    expect(qualityParams).toHaveLength(1);
    expect(qualityParams[0]?.options?.map((option) => option.value)).toEqual([
      '1k',
      '2k',
      '4k',
    ]);
  });

  it('为 Midjourney 暴露 V8 和 V8.1 版本参数', () => {
    const params = getCompatibleParams('mj-imagine');
    const versionParam = params.find((param) => param.id === 'mj_v');

    expect(versionParam?.options?.map((option) => option.value)).toEqual([
      'default',
      '8.1',
      '8',
      '7',
      '6',
    ]);
  });

  it('为 Midjourney 参数使用标签兼容而不是固定模型 ID', () => {
    const params = getCompatibleParams('mj-imagine');

    ['mj_ar', 'mj_v', 'mj_style', 'mj_s', 'mj_q', 'mj_seed'].forEach(
      (paramId) => {
        expect(params.find((param) => param.id === paramId)?.compatibleModels).toEqual([]);
        expect(params.find((param) => param.id === paramId)?.compatibleTags).toEqual([
          'mj',
          'midjourney',
        ]);
      }
    );
  });

  it('只为 Midjourney 模型暴露 Midjourney 参数', () => {
    setRuntimeModelConfigs([
      {
        id: 'mj_fast_background_eraser',
        label: 'mj_fast_background_eraser',
        type: 'image',
        vendor: ModelVendor.MIDJOURNEY,
        tags: ['runtime', 'mj'],
      },
    ]);

    const mjRuntimeParamIds = getCompatibleParams(
      'mj_fast_background_eraser'
    ).map((param) => param.id);
    const gptParamIds = getCompatibleParams('gpt-image-2').map(
      (param) => param.id
    );

    expect(mjRuntimeParamIds).toContain('mj_ar');
    expect(mjRuntimeParamIds).toContain('mj_v');
    expect(gptParamIds).not.toContain('mj_ar');
    expect(gptParamIds).not.toContain('mj_v');
  });


});

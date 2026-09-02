import { describe, expect, it } from 'vitest';
import { ModelVendor, type ModelConfig } from '../../constants/model-config';
import {
  compareModelsByDisplayPriority,
  sortModelsByDisplayPriority,
} from '../model-sort';

function createImageModel(
  id: string,
  overrides: Partial<ModelConfig> = {}
): ModelConfig {
  return {
    id,
    label: id,
    type: 'image',
    vendor: ModelVendor.GEMINI,
    ...overrides,
  };
}

describe('model-sort', () => {
  it('在没有显式顺序时，同一系列按版本号从新到旧排序', () => {
    // 全部为同一系列（命名键相同：gemini flash image preview），
    // 仅版本号不同，用于验证同名聚合后按新版本优先排序。
    const models = [
      createImageModel('gemini-2.5-flash-image-preview'),
      createImageModel('gemini-3-flash-image-preview'),
      createImageModel('gemini-3.1-flash-image-preview'),
    ];

    expect(sortModelsByDisplayPriority(models).map((model) => model.id)).toEqual([
      'gemini-3.1-flash-image-preview',
      'gemini-3-flash-image-preview',
      'gemini-2.5-flash-image-preview',
    ]);
  });

  it('不会让分辨率后缀盖过主版本号', () => {
    const models = [
      createImageModel('gemini-3-pro-image-preview-4k'),
      createImageModel('gemini-3.1-flash-image-preview'),
    ];

    expect(sortModelsByDisplayPriority(models).map((model) => model.id)).toEqual([
      'gemini-3.1-flash-image-preview',
      'gemini-3-pro-image-preview-4k',
    ]);
  });

  it('显式顺序优先于版本号', () => {
    const pinnedModel = {
      ...createImageModel('gemini-2.5-flash-image'),
      sortOrder: 0,
    } as ModelConfig & { sortOrder: number };
    const newerModel = createImageModel('gemini-3.1-flash-image-preview');

    expect(compareModelsByDisplayPriority(pinnedModel, newerModel)).toBeLessThan(0);
  });

  it('同版本时 Pro 优先于非 Pro', () => {
    // async/vip 后缀在命名键中被忽略，两个模型命名键（gemini image preview）
    // 与版本（3）均相同，仅 description 中的 Pro 档次不同，用于验证档位兜底排序。
    const models = [
      createImageModel('gemini-3-image-preview-async', {
        description: '标准版本',
      }),
      createImageModel('gemini-3-image-preview-vip', {
        description: 'Pro 版本',
      }),
    ];

    expect(sortModelsByDisplayPriority(models).map((model) => model.id)).toEqual([
      'gemini-3-image-preview-vip',
      'gemini-3-image-preview-async',
    ]);
  });

  it('同版本同档位时 4K 优先于 2K 和默认', () => {
    const models = [
      createImageModel('gemini-3-pro-image-preview'),
      createImageModel('gemini-3-pro-image-preview-2k'),
      createImageModel('gemini-3-pro-image-preview-4k'),
    ];

    expect(sortModelsByDisplayPriority(models).map((model) => model.id)).toEqual([
      'gemini-3-pro-image-preview-4k',
      'gemini-3-pro-image-preview-2k',
      'gemini-3-pro-image-preview',
    ]);
  });

  it('推荐分优先于跨系列名称和版本排序', () => {
    const models = [
      createImageModel('gpt-4o-image', {
        vendor: ModelVendor.GPT,
        recommendedScore: -999,
      }),
      createImageModel('gpt-image-2', {
        vendor: ModelVendor.GPT,
        recommendedScore: 95,
      }),
      createImageModel('gpt-image-1', {
        vendor: ModelVendor.GPT,
        recommendedScore: 87,
      }),
    ];

    expect(sortModelsByDisplayPriority(models).map((model) => model.id)).toEqual([
      'gpt-image-2',
      'gpt-image-1',
      'gpt-4o-image',
    ]);
  });
});

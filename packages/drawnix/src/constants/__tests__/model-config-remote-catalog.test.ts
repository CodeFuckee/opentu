import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRemoteModelCatalog,
  clearRuntimeModelConfigs,
  getModelsByType,
  getModelConfig,
  getRemoteModelCatalogModels,
  getStaticModelsByType,
  setRemoteModelCatalog,
  setRuntimeModelConfigs,
  type ModelConfig,
} from '../model-config';

function makeModel(
  overrides: Partial<ModelConfig> & { id: string }
): ModelConfig {
  return {
    type: 'video',
    vendor: 'OTHER',
    label: overrides.id,
    ...overrides,
  };
}

describe('model-config 远程目录合并优先级', () => {
  afterEach(() => {
    clearRemoteModelCatalog();
    clearRuntimeModelConfigs();
  });

  it('云端目录条目覆盖静态内置同名模型', () => {
    const builtin = getStaticModelsByType('video');
    expect(builtin.length).toBeGreaterThan(0);

    const remoteOverride = makeModel({
      id: builtin[0].id,
      label: '云端覆盖版',
      type: builtin[0].type,
    });
    setRemoteModelCatalog([remoteOverride]);

    const models = getModelsByType(builtin[0].type);
    const matched = models.filter((model) => model.id === builtin[0].id);
    expect(matched).toHaveLength(1);
    expect(matched[0].label).toBe('云端覆盖版');
    expect(getModelConfig(builtin[0].id)?.label).toBe('云端覆盖版');
  });

  it('云端目录条目覆盖运行时发现同名模型', () => {
    setRuntimeModelConfigs([
      makeModel({ id: 'remote-test-model', label: '运行时发现版' }),
    ]);
    setRemoteModelCatalog([
      makeModel({ id: 'remote-test-model', label: '云端目录版' }),
    ]);

    const models = getModelsByType('video');
    const matched = models.filter((model) => model.id === 'remote-test-model');
    expect(matched).toHaveLength(1);
    expect(matched[0].label).toBe('云端目录版');
  });

  it('目录接管后静态独有模型不再出现（表是唯一事实源）', () => {
    // 接管前：静态模型在列
    const builtin = getStaticModelsByType('video')[0];
    expect(getModelConfig(builtin.id)?.id).toBe(builtin.id);

    // 接管后：目录里没有的静态模型被隐藏
    setRemoteModelCatalog([
      makeModel({ id: 'catalog-only-model', label: '目录模型' }),
    ]);
    expect(getModelConfig(builtin.id)).toBeUndefined();
    expect(
      getModelsByType('video').some((model) => model.id === builtin.id)
    ).toBe(false);
    expect(
      getModelsByType('video').some((model) => model.id === 'catalog-only-model')
    ).toBe(true);
  });

  it('清空云端目录后恢复静态与运行时发现行为', () => {
    const builtin = getStaticModelsByType('video');
    setRemoteModelCatalog([
      makeModel({ id: builtin[0].id, label: '云端覆盖版' }),
    ]);
    expect(getModelConfig(builtin[0].id)?.label).toBe('云端覆盖版');

    clearRemoteModelCatalog();
    expect(getModelConfig(builtin[0].id)?.label).toBe(builtin[0].label);
  });

  it('getRemoteModelCatalogModels 按类型过滤', () => {
    setRemoteModelCatalog([
      makeModel({ id: 'cat-video', type: 'video' }),
      makeModel({ id: 'cat-image', type: 'image' }),
    ]);

    expect(
      getRemoteModelCatalogModels('image').map((model) => model.id)
    ).toEqual(['cat-image']);
    expect(getRemoteModelCatalogModels()).toHaveLength(2);
  });
});

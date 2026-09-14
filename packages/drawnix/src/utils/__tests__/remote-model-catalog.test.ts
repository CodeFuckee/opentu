import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRemoteModelCatalog,
  clearRuntimeModelConfigs,
  getModelsByType,
  getRemoteModelCatalogModels,
  getStaticModelsByType,
} from '../../constants/model-config';
import { getSelectableModels } from '../runtime-model-discovery';
import {
  adaptCatalogRow,
  configureRemoteModelCatalog,
  getRemoteModelCatalogState,
  refreshRemoteModelCatalog,
} from '../remote-model-catalog';

const CACHE_KEY = 'drawnix-remote-model-catalog';
const TEST_SUPABASE_URL = 'https://supabase.test';
const TEST_ANON_KEY = 'anon-key-test';

function makeValidRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'seedance-test-pro',
    type: 'video',
    vendor: 'DOUBAO',
    label: 'Seedance 测试版',
    short_label: '测试版',
    description: '云端目录测试条目',
    is_vip: true,
    recommended_score: 88,
    video_defaults: { duration: '5', size: '1080p', aspectRatio: '16:9' },
    tags: ['seedance'],
    enabled: true,
    ...overrides,
  };
}

async function stubFetchOnce(
  payload: unknown,
  response?: Partial<{ ok: boolean; status: number; text: string }>
) {
  const fetchMock = vi.fn(async () => ({
    ok: response?.ok ?? true,
    status: response?.status ?? 200,
    text: async () => response?.text ?? '',
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('remote-model-catalog 行校验与转换', () => {
  it('合法行转换为完整 ModelConfig', () => {
    const model = adaptCatalogRow(makeValidRow());

    expect(model).not.toBeNull();
    expect(model).toMatchObject({
      id: 'seedance-test-pro',
      type: 'video',
      vendor: 'DOUBAO',
      label: 'Seedance 测试版',
      shortLabel: '测试版',
      description: '云端目录测试条目',
      isVip: true,
      recommendedScore: 88,
      videoDefaults: { duration: '5', size: '1080p', aspectRatio: '16:9' },
      tags: ['seedance'],
    });
    expect(model?.shortCode).toBeTruthy();
    expect(model?.sourceProfileId).toBeUndefined();
  });

  it('short_label 缺省时回退为 label', () => {
    const model = adaptCatalogRow(makeValidRow({ short_label: null }));
    expect(model?.shortLabel).toBe('Seedance 测试版');
  });

  it('缺失 id/label 或类型非法时整行拒绝', () => {
    expect(adaptCatalogRow(null)).toBeNull();
    expect(adaptCatalogRow('not-an-object')).toBeNull();
    expect(adaptCatalogRow(makeValidRow({ id: '' }))).toBeNull();
    expect(adaptCatalogRow(makeValidRow({ label: '  ' }))).toBeNull();
    expect(adaptCatalogRow(makeValidRow({ type: '3d' }))).toBeNull();
    expect(adaptCatalogRow(makeValidRow({ type: null }))).toBeNull();
  });

  it('未知厂商降级为 OTHER 而不是拒绝', () => {
    const model = adaptCatalogRow(makeValidRow({ vendor: 'NEW_VENDOR' }));
    expect(model?.vendor).toBe('OTHER');
  });

  it('畸形 defaults 与 tags 被安全丢弃', () => {
    const model = adaptCatalogRow(
      makeValidRow({
        image_defaults: { aspectRatio: '1:1' },
        video_defaults: { duration: 5, size: '1080p', aspectRatio: '16:9' },
        tags: ['', 'valid-tag', 42],
      })
    );

    expect(model?.imageDefaults).toBeUndefined();
    expect(model?.videoDefaults).toBeUndefined();
    expect(model?.tags).toEqual(['valid-tag']);
  });
});

describe('remote-model-catalog 拉取与降级', () => {
  beforeEach(() => {
    window.localStorage.clear();
    configureRemoteModelCatalog(null);
    clearRemoteModelCatalog();
    clearRuntimeModelConfigs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    configureRemoteModelCatalog(null);
    clearRemoteModelCatalog();
  });

  it('拉取成功后条目全局生效并写入缓存', async () => {
    configureRemoteModelCatalog({
      supabaseUrl: TEST_SUPABASE_URL,
      anonKey: TEST_ANON_KEY,
    });
    const fetchMock = await stubFetchOnce([makeValidRow()]);

    await refreshRemoteModelCatalog({ force: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${TEST_SUPABASE_URL}/rest/v1/model_catalog?select=*&enabled=eq.true`
    );
    expect((init.headers as Record<string, string>).apikey).toBe(
      TEST_ANON_KEY
    );

    const state = getRemoteModelCatalogState();
    expect(state.status).toBe('ready');
    expect(state.appliedCount).toBe(1);
    expect(getRemoteModelCatalogModels('video')[0]?.id).toBe(
      'seedance-test-pro'
    );

    const cache = JSON.parse(
      window.localStorage.getItem(CACHE_KEY) || 'null'
    ) as { rows: unknown[]; fetchedAt: number };
    expect(cache.rows).toHaveLength(1);
    expect(cache.fetchedAt).toBeGreaterThan(0);
  });

  it('目录接管后选择器仅呈现表内条目，静态内置退位', async () => {
    configureRemoteModelCatalog({
      supabaseUrl: TEST_SUPABASE_URL,
      anonKey: TEST_ANON_KEY,
    });
    const staticOnlyId = getStaticModelsByType('video')[0].id;
    // 接管前：静态模型在列
    expect(
      getSelectableModels('video').some((model) => model.id === staticOnlyId)
    ).toBe(true);

    await stubFetchOnce([makeValidRow()]);
    await refreshRemoteModelCatalog({ force: true });

    const selectableIds = getSelectableModels('video').map(
      (model) => model.id
    );
    expect(selectableIds).not.toContain(staticOnlyId);
    expect(selectableIds).toContain('seedance-test-pro');
  });

  it('非法行被跳过，不影响合法条目', async () => {
    configureRemoteModelCatalog({
      supabaseUrl: TEST_SUPABASE_URL,
      anonKey: TEST_ANON_KEY,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await stubFetchOnce([
      makeValidRow(),
      makeValidRow({ id: 'bad-row', type: 'unknown-type' }),
    ]);

    await refreshRemoteModelCatalog({ force: true });

    expect(getRemoteModelCatalogModels()).toHaveLength(1);
    expect(getRemoteModelCatalogModels()[0]?.id).toBe('seedance-test-pro');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('拉取失败且无缓存时保持静态行为', async () => {
    configureRemoteModelCatalog({
      supabaseUrl: TEST_SUPABASE_URL,
      anonKey: TEST_ANON_KEY,
    });
    await stubFetchOnce(null, { ok: false, status: 500 });

    await refreshRemoteModelCatalog({ force: true });

    const state = getRemoteModelCatalogState();
    expect(state.status).toBe('error');
    expect(state.error).toContain('500');
    expect(getRemoteModelCatalogModels()).toHaveLength(0);
    // 静态内置仍然可用
    expect(getModelsByType('video').length).toBeGreaterThan(0);
  });

  it('拉取失败时回退 7 天内的本地缓存', async () => {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        fetchedAt: Date.now(),
        rows: [makeValidRow({ id: 'cached-model' })],
      })
    );
    configureRemoteModelCatalog({
      supabaseUrl: TEST_SUPABASE_URL,
      anonKey: TEST_ANON_KEY,
    });
    // 注水后即已生效
    expect(getRemoteModelCatalogModels()[0]?.id).toBe('cached-model');

    await stubFetchOnce(null, { ok: false, status: 503 });
    await refreshRemoteModelCatalog({ force: true });

    const state = getRemoteModelCatalogState();
    expect(state.status).toBe('error');
    expect(state.error).toContain('缓存');
    expect(getRemoteModelCatalogModels()[0]?.id).toBe('cached-model');
  });

  it('超过 7 天的缓存不再注水', () => {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        rows: [makeValidRow({ id: 'stale-model' })],
      })
    );
    configureRemoteModelCatalog({
      supabaseUrl: TEST_SUPABASE_URL,
      anonKey: TEST_ANON_KEY,
    });

    expect(getRemoteModelCatalogModels()).toHaveLength(0);
  });

  it('TTL 内的重复刷新跳过请求，force 绕过', async () => {
    configureRemoteModelCatalog({
      supabaseUrl: TEST_SUPABASE_URL,
      anonKey: TEST_ANON_KEY,
    });
    const fetchMock = await stubFetchOnce([makeValidRow()]);
    await refreshRemoteModelCatalog({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await refreshRemoteModelCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await refreshRemoteModelCatalog({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('未配置时刷新是空操作', async () => {
    const fetchMock = await stubFetchOnce([makeValidRow()]);
    await refreshRemoteModelCatalog({ force: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRemoteModelCatalog,
  clearRuntimeModelConfigs,
} from '../constants/model-config';
import {
  configureRemoteModelCatalog,
  refreshRemoteModelCatalog,
} from '../utils/remote-model-catalog';
import { usePreferredModels, useSelectableModels } from './use-runtime-models';

const CACHE_KEY = 'drawnix-remote-model-catalog';

function makeRow() {
  return {
    id: 'catalog-reactive-model',
    type: 'video',
    vendor: 'DOUBAO',
    label: '云端目录响应式条目',
    enabled: true,
  };
}

describe('use-runtime-models 云端目录响应式', () => {
  beforeEach(() => {
    window.localStorage.clear();
    configureRemoteModelCatalog({
      supabaseUrl: 'https://supabase.test',
      anonKey: 'anon-key-test',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    configureRemoteModelCatalog(null);
    clearRemoteModelCatalog();
    clearRuntimeModelConfigs();
  });

  it('目录后台拉取完成后选择器列表自动包含新条目（无需重新挂载）', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      )
    );

    const { result } = renderHook(() => useSelectableModels('video'));

    // 拉取完成前：列表不包含云端条目
    expect(
      result.current.some((model) => model.id === 'catalog-reactive-model')
    ).toBe(false);

    // 拉取完成：hook 应自动重算并包含新条目。
    // 注意先启动 refresh（其内部会同步调用 fetch 并捕获 resolver），再 resolve 响应
    await act(async () => {
      const refreshPromise = refreshRemoteModelCatalog({ force: true });
      resolveFetch?.({
        ok: true,
        status: 200,
        json: async () => [makeRow()],
      });
      await refreshPromise;
    });

    await waitFor(() => {
      expect(
        result.current.some((model) => model.id === 'catalog-reactive-model')
      ).toBe(true);
    });
  });

  it('usePreferredModels 同样响应目录更新', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => [makeRow()],
      }))
    );

    const { result } = renderHook(() => usePreferredModels('video'));
    expect(
      result.current.some((model) => model.id === 'catalog-reactive-model')
    ).toBe(false);

    await act(async () => {
      await refreshRemoteModelCatalog({ force: true });
    });

    await waitFor(() => {
      expect(
        result.current.some((model) => model.id === 'catalog-reactive-model')
      ).toBe(true);
    });
  });
});

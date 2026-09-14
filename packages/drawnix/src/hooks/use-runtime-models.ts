import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ModelConfig, ModelType } from '../constants/model-config';
import {
  getProfilePreferredModels,
  getPreferredModels,
  getSelectableModels,
  runtimeModelDiscovery,
  type RuntimeModelDiscoveryState,
} from '../utils/runtime-model-discovery';
import {
  getRemoteModelCatalogState,
  subscribeRemoteModelCatalog,
} from '../utils/remote-model-catalog';
import { LEGACY_DEFAULT_PROVIDER_PROFILE_ID } from '../utils/settings-manager';

export function useRuntimeModelDiscoveryState(
  profileId = LEGACY_DEFAULT_PROVIDER_PROFILE_ID
): RuntimeModelDiscoveryState {
  const [state, setState] = useState<RuntimeModelDiscoveryState>(() =>
    runtimeModelDiscovery.getState(profileId)
  );

  useEffect(() => {
    setState(runtimeModelDiscovery.getState(profileId));
    return runtimeModelDiscovery.subscribe(() => {
      setState(runtimeModelDiscovery.getState(profileId));
    });
  }, [profileId]);

  return state;
}

/**
 * 云端模型目录的生效版本（fetchedAt）。目录不在 runtimeModelDiscovery store 内，
 * 相关 hook 需单独订阅它，否则目录后台拉取完成后模型列表不会重算。
 */
function useRemoteModelCatalogVersion(): number {
  const catalogState = useSyncExternalStore(
    subscribeRemoteModelCatalog,
    getRemoteModelCatalogState
  );
  return catalogState.fetchedAt ?? 0;
}

/**
 * 比较两个 ModelConfig 数组是否内容相同（按 id + selectionKey）
 */
function areModelListsEqual(a: ModelConfig[], b: ModelConfig[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].selectionKey !== b[i].selectionKey) return false;
  }
  return true;
}

export function usePreferredModels(modelType: ModelType): ModelConfig[] {
  const state = useRuntimeModelDiscoveryState();
  const catalogVersion = useRemoteModelCatalogVersion();
  const prevRef = useRef<ModelConfig[]>([]);
  return useMemo(() => {
    const next = getPreferredModels(modelType);
    if (areModelListsEqual(prevRef.current, next)) return prevRef.current;
    prevRef.current = next;
    return next;
  }, [modelType, state, catalogVersion]);
}

export function useSelectableModels(modelType: ModelType): ModelConfig[] {
  const state = useRuntimeModelDiscoveryState();
  const catalogVersion = useRemoteModelCatalogVersion();
  const prevRef = useRef<ModelConfig[]>([]);
  return useMemo(() => {
    const next = getSelectableModels(modelType);
    if (areModelListsEqual(prevRef.current, next)) return prevRef.current;
    prevRef.current = next;
    return next;
  }, [modelType, state, catalogVersion]);
}

export function useProfilePreferredModels(
  profileId: string,
  modelType: ModelType
): ModelConfig[] {
  const state = useRuntimeModelDiscoveryState(profileId);
  const prevRef = useRef<ModelConfig[]>([]);
  return useMemo(() => {
    const next = getProfilePreferredModels(profileId, modelType);
    if (areModelListsEqual(prevRef.current, next)) return prevRef.current;
    prevRef.current = next;
    return next;
  }, [profileId, modelType, state]);
}

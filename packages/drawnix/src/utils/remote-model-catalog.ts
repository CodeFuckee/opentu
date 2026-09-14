/**
 * 云端模型目录（Supabase model_catalog 表驱动）
 *
 * 应用启动时由宿主（apps/web）经 configureRemoteModelCatalog 注入 Supabase
 * 连接信息并触发首次拉取，与登录态无关（未登录 BYOK 用户也需要目录）。
 * 条目经逐行校验转换为 ModelConfig 后经 setRemoteModelCatalog 全局生效；
 * 拉取失败回退 localStorage 缓存，缓存不可用时保持静态内置目录不变。
 *
 * 合并优先级见 constants/model-config.ts：remote catalog > runtime discovery > static。
 */
import {
  type ImageModelDefaults,
  type ModelConfig,
  type ModelType,
  type VideoModelDefaults,
  ModelVendor,
  setRemoteModelCatalog,
  clearRemoteModelCatalog,
} from '../constants/model-config';
import { buildShortCode } from './runtime-model-discovery';

const REMOTE_MODEL_CATALOG_CACHE_KEY = 'drawnix-remote-model-catalog';
const DEFAULT_TABLE_NAME = 'model_catalog';
/** 两次拉取的最小间隔（强制刷新可绕过） */
const REFRESH_TTL_MS = 10 * 60 * 1000;
/** 缓存最大年龄：超过后不再作为降级数据源（防止复活已删除条目） */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MODEL_TYPE_VALUES: ModelType[] = ['image', 'video', 'text', 'audio'];
const MODEL_VENDOR_VALUES = new Set<string>(
  Object.values(ModelVendor) as string[]
);

export interface RemoteModelCatalogConfig {
  supabaseUrl: string;
  anonKey: string;
  /** 表名，默认 model_catalog */
  tableName?: string;
}

export interface RemoteModelCatalogRow {
  id: string;
  type: string;
  vendor: string;
  label: string;
  short_label?: string | null;
  short_code?: string | null;
  description?: string | null;
  is_vip?: boolean | null;
  supports_tools?: boolean | null;
  recommended_score?: number | null;
  image_defaults?: Partial<ImageModelDefaults> | null;
  video_defaults?: Partial<VideoModelDefaults> | null;
  tags?: string[] | null;
  enabled?: boolean | null;
}

export interface RemoteModelCatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  models: ModelConfig[];
  fetchedAt: number | null;
  /** 本次会话成功生效的条目数（缓存注水也会更新） */
  appliedCount: number;
  error: string | null;
}

interface RemoteModelCatalogCache {
  fetchedAt: number;
  rows: RemoteModelCatalogRow[];
}

type CatalogListener = () => void;

let catalogConfig: RemoteModelCatalogConfig | null = null;
let catalogState: RemoteModelCatalogState = createIdleState();
let inFlight: Promise<void> | null = null;
const listeners = new Set<CatalogListener>();

function createIdleState(): RemoteModelCatalogState {
  return {
    status: 'idle',
    models: [],
    fetchedAt: null,
    appliedCount: 0,
    error: null,
  };
}

function setState(next: Partial<RemoteModelCatalogState>): void {
  catalogState = { ...catalogState, ...next };
  for (const listener of listeners) {
    listener();
  }
}

export function configureRemoteModelCatalog(
  config: RemoteModelCatalogConfig | null
): void {
  catalogConfig = config;
  if (!config) {
    clearRemoteModelCatalog();
    catalogState = createIdleState();
    for (const listener of listeners) {
      listener();
    }
    return;
  }
  hydrateFromCache();
}

export function getRemoteModelCatalogState(): RemoteModelCatalogState {
  return catalogState;
}

export function subscribeRemoteModelCatalog(
  listener: CatalogListener
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ============================================
// 行校验与 ModelConfig 转换
// ============================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function adaptImageDefaults(
  value: unknown
): ImageModelDefaults | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    !isNonEmptyString(raw.aspectRatio) ||
    typeof raw.width !== 'number' ||
    !Number.isFinite(raw.width) ||
    typeof raw.height !== 'number' ||
    !Number.isFinite(raw.height)
  ) {
    return undefined;
  }
  return {
    aspectRatio: raw.aspectRatio,
    width: raw.width,
    height: raw.height,
  };
}

function adaptVideoDefaults(
  value: unknown
): VideoModelDefaults | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    !isNonEmptyString(raw.duration) ||
    !isNonEmptyString(raw.size) ||
    !isNonEmptyString(raw.aspectRatio)
  ) {
    return undefined;
  }
  return {
    duration: raw.duration,
    size: raw.size,
    aspectRatio: raw.aspectRatio,
  };
}

function adaptTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags = value.filter(isNonEmptyString);
  return tags.length > 0 ? tags : undefined;
}

/**
 * 将目录行转换为 ModelConfig；非法行返回 null 并由调用方跳过。
 * id / type / label 任一缺失或非法即整行拒绝；vendor 非法降级为 OTHER。
 */
export function adaptCatalogRow(row: unknown): ModelConfig | null {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const raw = row as Record<string, unknown>;
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.label)) {
    return null;
  }
  const type = MODEL_TYPE_VALUES.find((item) => item === raw.type);
  if (!type) {
    return null;
  }
  const vendor = isNonEmptyString(raw.vendor)
    ? (MODEL_VENDOR_VALUES.has(raw.vendor)
        ? (raw.vendor as ModelVendor)
        : ModelVendor.OTHER)
    : ModelVendor.OTHER;

  const config: ModelConfig = {
    id: raw.id,
    type,
    vendor,
    label: raw.label,
    shortLabel: isNonEmptyString(raw.short_label)
      ? raw.short_label
      : raw.label,
    description: isNonEmptyString(raw.description) ? raw.description : undefined,
    isVip: raw.is_vip === true,
    supportsTools: raw.supports_tools === true,
  };

  if (isNonEmptyString(raw.short_code)) {
    config.shortCode = raw.short_code;
  } else {
    config.shortCode = buildShortCode(raw.id, type);
  }

  if (typeof raw.recommended_score === 'number' && Number.isFinite(raw.recommended_score)) {
    config.recommendedScore = raw.recommended_score;
  }

  const imageDefaults = adaptImageDefaults(raw.image_defaults);
  if (imageDefaults) {
    config.imageDefaults = imageDefaults;
  }
  const videoDefaults = adaptVideoDefaults(raw.video_defaults);
  if (videoDefaults) {
    config.videoDefaults = videoDefaults;
  }
  const tags = adaptTags(raw.tags);
  if (tags) {
    config.tags = tags;
  }

  return config;
}

// ============================================
// 缓存
// ============================================

function readCache(): RemoteModelCatalogCache | null {
  try {
    const raw = window.localStorage.getItem(REMOTE_MODEL_CATALOG_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as RemoteModelCatalogCache;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.rows) ||
      !Number.isFinite(parsed.fetchedAt)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(rows: RemoteModelCatalogRow[]): void {
  try {
    const cache: RemoteModelCatalogCache = {
      fetchedAt: Date.now(),
      rows,
    };
    window.localStorage.setItem(
      REMOTE_MODEL_CATALOG_CACHE_KEY,
      JSON.stringify(cache)
    );
  } catch {
    // 缓存写失败（隐私模式/容量不足）不影响主流程
  }
}

/** 启动注水：缓存新鲜（7 天内）时先应用，后续刷新覆盖 */
function hydrateFromCache(): void {
  const cache = readCache();
  if (!cache || Date.now() - cache.fetchedAt > CACHE_MAX_AGE_MS) {
    return;
  }
  const models = adaptCatalogRows(cache.rows);
  if (models.length === 0) {
    return;
  }
  setRemoteModelCatalog(models);
  setState({
    status: 'ready',
    models,
    fetchedAt: cache.fetchedAt,
    appliedCount: models.length,
    error: null,
  });
}

function adaptCatalogRows(rows: RemoteModelCatalogRow[]): ModelConfig[] {
  const models: ModelConfig[] = [];
  for (const row of rows) {
    const model = adaptCatalogRow(row);
    if (model) {
      models.push(model);
    } else if (row && typeof row === 'object' && isNonEmptyString((row as RemoteModelCatalogRow).id)) {
      console.warn(
        `[remote-model-catalog] 跳过非法目录条目: ${(row as RemoteModelCatalogRow).id}`
      );
    }
  }
  return models;
}

// ============================================
// 拉取
// ============================================

function buildCatalogRequestUrl(config: RemoteModelCatalogConfig): string {
  const base = config.supabaseUrl.trim().replace(/\/+$/, '');
  const table = config.tableName?.trim() || DEFAULT_TABLE_NAME;
  return `${base}/rest/v1/${table}?select=*&enabled=eq.true`;
}

function extractErrorMessage(rawText: string, fallback: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: string;
      error_description?: string;
      error?: string;
    };
    return parsed.message || parsed.error_description || parsed.error || fallback;
  } catch {
    return trimmed.slice(0, 200);
  }
}

/**
 * 拉取并应用云端模型目录。
 * 默认受 10 分钟 TTL 约束；`force: true` 绕过 TTL 立即拉取（设置弹窗手动同步）。
 */
export async function refreshRemoteModelCatalog(
  options?: { force?: boolean }
): Promise<void> {
  if (!catalogConfig) {
    return;
  }
  if (inFlight) {
    return inFlight;
  }
  if (
    !options?.force &&
    catalogState.fetchedAt &&
    Date.now() - catalogState.fetchedAt < REFRESH_TTL_MS &&
    catalogState.status !== 'error'
  ) {
    return;
  }

  const config = catalogConfig;
  const requestUrl = buildCatalogRequestUrl(config);
  inFlight = (async () => {
    setState({ status: 'loading', error: null });
    try {
      const response = await fetch(requestUrl, {
        method: 'GET',
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        const rawText = await response.text().catch(() => '');
        throw new Error(
          `云端模型目录拉取失败（HTTP ${response.status}）：${extractErrorMessage(rawText, '请稍后重试')}`
        );
      }
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) {
        throw new Error('云端模型目录返回格式异常（非数组）');
      }
      const rows = payload as RemoteModelCatalogRow[];
      const models = adaptCatalogRows(rows);
      setRemoteModelCatalog(models);
      writeCache(rows);
      setState({
        status: 'ready',
        models,
        fetchedAt: Date.now(),
        appliedCount: models.length,
        error: null,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '云端模型目录拉取失败';
      // 降级：使用 7 天内的本地缓存；无缓存则保持当前生效状态（静态兜底）
      const cache = readCache();
      const cacheUsable =
        cache && Date.now() - cache.fetchedAt <= CACHE_MAX_AGE_MS;
      const models = cacheUsable ? adaptCatalogRows(cache.rows) : [];
      if (cacheUsable && models.length > 0) {
        setRemoteModelCatalog(models);
        setState({
          status: 'error',
          models,
          appliedCount: models.length,
          error: `${message}（已回退本地缓存）`,
        });
      } else {
        setState({ status: 'error', error: message });
      }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

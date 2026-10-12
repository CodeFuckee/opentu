/**
 * Supabase 仓库层：user_sync_data / user_sync_media 读写封装
 *
 * 全部操作通过依赖注入的 client 执行；错误以 { error } 形式返回（不抛出）。
 * 与 task-submissions 的调用风格一致：.from(表).select/upsert/update。
 */

import type { SupabaseSyncConfig } from './types';
import type {
  SyncEntity,
  SyncMediaItem,
  SyncEntityType,
  RemoteEntityKey,
} from './types';
import { entityKey, parseEntityKey } from './checksum';

/** 表名常量 */
export const SYNC_DATA_TABLE = 'user_sync_data';
export const SYNC_MEDIA_TABLE = 'user_sync_media';

/** 行到客户端实体的反序列化（DB timestamptz → epoch ms） */
export function rowToEntity(row: Record<string, unknown>): SyncEntity | null {
  const entityType = row.entity_type as string;
  const entityId = row.entity_id as string;
  if (!entityType || !entityId) {
    return null;
  }
  const updatedAt = parseTimestamp(row.updated_at);
  const deletedAt = row.deleted_at ? parseTimestamp(row.deleted_at) : null;
  return {
    entity_type: entityType as SyncEntityType,
    entity_id: entityId,
    content: row.content ?? null,
    checksum: (row.checksum as string) ?? '',
    updated_at: updatedAt,
    deleted_at: deletedAt,
  };
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return 0;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

/**
 * 远程实体键扫描（轻列：不含 content——键全量用于墓碑判定，行数可能数千但
 * 单行体积极小；openspec improve-sync-performance「键全量、内容增量」）。
 */
export async function fetchRemoteEntityKeys(
  config: SupabaseSyncConfig,
  userId: string
): Promise<{ keys: RemoteEntityKey[]; error?: unknown }> {
  try {
    const client = config.client as {
      from: (table: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            range: (from: number, to: number) => Promise<{
              data: Array<Record<string, unknown>> | null;
              error: unknown;
            }>;
          };
        };
      };
    };
    const PAGE = 1000;
    const keys: RemoteEntityKey[] = [];
    let offset = 0;
    for (;;) {
      const { data, error } = await client
        .from(SYNC_DATA_TABLE)
        .select('entity_type,entity_id,updated_at,deleted_at')
        .eq('user_id', userId)
        .range(offset, offset + PAGE - 1);
      if (error) {
        return { keys: [], error };
      }
      const rows = data ?? [];
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        const entityType = row.entity_type as string;
        const entityId = row.entity_id as string;
        if (!entityType || !entityId) {
          continue;
        }
        keys.push({
          entityType: entityType as RemoteEntityKey['entityType'],
          entityId,
          updatedAt: parseTimestamp(row.updated_at),
          deletedAt: row.deleted_at ? parseTimestamp(row.deleted_at) : null,
        });
      }
      if (rows.length < PAGE) {
        break;
      }
      offset += PAGE;
    }
    return { keys };
  } catch (error) {
    return { keys: [], error };
  }
}

/**
 * 拉取用户全部同步实体。
 * PostgREST 单次返回有行数上限，超大数据（数千实体）可用分页；默认按 updated_at 升序分页取全量。
 */
export async function fetchRemoteEntities(
  config: SupabaseSyncConfig,
  userId: string,
  options?: { sinceMs?: number | null }
): Promise<{ entities: SyncEntity[]; error?: unknown }> {
  try {
    // 增量窗口（openspec improve-sync-performance）：lastSync 存在时只拉窗口内
    // 变更行（软删除会 bump updated_at，墓碑天然入窗）；null = 首同步全量
    const sinceMs = options?.sinceMs ?? null;
    const client = config.client as {
      from: (table: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            gte?: (col: string, val: string) => {
              order: (col: string, opts?: { ascending?: boolean }) => {
                range: (from: number, to: number) => {
                  limit: (n: number) => Promise<{
                    data: Array<Record<string, unknown>> | null;
                    error: unknown;
                  }>;
                };
              };
            };
            order: (col: string, opts?: { ascending?: boolean }) => {
              range: (from: number, to: number) => {
                limit: (n: number) => Promise<{
                  data: Array<Record<string, unknown>> | null;
                  error: unknown;
                }>;
              };
            };
          };
        };
      };
    };
    const PAGE = 1000;
    const entities: SyncEntity[] = [];
    let offset = 0;
    for (;;) {
      let query = client
        .from(SYNC_DATA_TABLE)
        .select('*')
        .eq('user_id', userId);
      if (sinceMs !== null && query.gte) {
        query = query.gte('updated_at', toIso(sinceMs));
      }
      const { data, error } = await query
        .order('updated_at', { ascending: true })
        .range(offset, offset + PAGE - 1)
        .limit(PAGE);
      if (error) {
        return { entities: [], error };
      }
      const rows = data ?? [];
      for (const row of rows) {
        const entity = rowToEntity(row);
        if (entity) {
          entities.push(entity);
        }
      }
      if (rows.length < PAGE) {
        break;
      }
      offset += PAGE;
    }
    return { entities };
  } catch (error) {
    return { entities: [], error };
  }
}

/** 批量 upsert 实体（每次一批，supabase upsert 需开启 onConflict） */
export async function upsertRemoteEntities(
  config: SupabaseSyncConfig,
  userId: string,
  entities: SyncEntity[]
): Promise<{ error?: unknown }> {
  try {
    if (entities.length === 0) {
      return {};
    }
    const client = config.client as {
      from: (table: string) => {
        upsert: (
          rows: Array<Record<string, unknown>>,
          opts: { onConflict: string }
        ) => Promise<{ error: unknown }>;
      };
    };
    const rows = entities.map((e) => ({
      user_id: userId,
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      content: e.content,
      checksum: e.checksum,
      updated_at: toIso(e.updated_at),
      deleted_at: e.deleted_at ? toIso(e.deleted_at) : null,
    }));
    const { error } = await client
      .from(SYNC_DATA_TABLE)
      .upsert(rows, { onConflict: 'user_id,entity_type,entity_id' });
    if (error) {
      return { error };
    }
    return {};
  } catch (error) {
    return { error };
  }
}

/** 软删除：云端标记 deleted_at（墓碑），实体键格式 "entity_type:entity_id" */
export async function softDeleteRemoteEntities(
  config: SupabaseSyncConfig,
  userId: string,
  keys: string[]
): Promise<{ error?: unknown }> {
  try {
    if (keys.length === 0) {
      return {};
    }
    const client = config.client as {
      from: (table: string) => {
        update: (patch: Record<string, unknown>) => {
          eq: (col: string, val: string) => {
            eq: (col2: string, val2: string) => {
              eq: (col3: string, val3: string) => Promise<{ error: unknown }>;
              in: (col3: string, vals: string[]) => Promise<{ error: unknown }>;
            };
          };
        };
      };
    };
    const now = new Date().toISOString();
    // 按 entity_type 分组后用 in 批量打墓碑：逐条 update 会让批量删除的
    // HTTP 往返数随墓碑数线性放大；组内仍按 entity_id 精确匹配，不会跨类型误删
    const idsByType = new Map<string, string[]>();
    for (const key of keys) {
      const parsed = parseEntityKey(key);
      if (!parsed) {
        continue;
      }
      const ids = idsByType.get(parsed.entityType);
      if (ids) {
        ids.push(parsed.entityId);
      } else {
        idsByType.set(parsed.entityType, [parsed.entityId]);
      }
    }
    for (const [entityType, entityIds] of idsByType) {
      const { error } = await client
        .from(SYNC_DATA_TABLE)
        .update({ deleted_at: now, updated_at: now })
        .eq('user_id', userId)
        .eq('entity_type', entityType)
        .in('entity_id', entityIds);
      if (error) {
        return { error };
      }
    }
    return {};
  } catch (error) {
    return { error };
  }
}

/** 拉取用户媒体元数据（分页取全量，防止大账号超过 PostgREST 单次行数上限被截断） */
export async function fetchRemoteMedia(
  config: SupabaseSyncConfig,
  userId: string
): Promise<{ media: SyncMediaItem[]; error?: unknown }> {
  try {
    const client = config.client as {
      from: (table: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            order: (col: string, opts?: { ascending?: boolean }) => {
              range: (from: number, to: number) => {
                limit: (n: number) => Promise<{
                  data: Array<Record<string, unknown>> | null;
                  error: unknown;
                }>;
              };
            };
          };
        };
      };
    };
    const PAGE = 1000;
    const rowsAll: Array<Record<string, unknown>> = [];
    let offset = 0;
    for (;;) {
      const { data, error } = await client
        .from(SYNC_MEDIA_TABLE)
        .select('*')
        .eq('user_id', userId)
        .order('url', { ascending: true })
        .range(offset, offset + PAGE - 1)
        .limit(PAGE);
      if (error) {
        return { media: [], error };
      }
      const rows = data ?? [];
      rowsAll.push(...rows);
      if (rows.length < PAGE) {
        break;
      }
      offset += PAGE;
    }
    const media = rowsAll.map((row) => ({
      url: row.url as string,
      type: (row.type ?? 'image') as SyncMediaItem['type'],
      mimeType: (row.mime_type as string) ?? undefined,
      size: (row.size as number) ?? undefined,
      storagePath: row.storage_path as string,
      updatedAt: parseTimestamp(row.updated_at),
    }));
    return { media };
  } catch (error) {
    return { media: [], error };
  }
}

/** upsert 媒体元数据 */
export async function upsertRemoteMedia(
  config: SupabaseSyncConfig,
  userId: string,
  items: SyncMediaItem[]
): Promise<{ error?: unknown }> {
  try {
    if (items.length === 0) {
      return {};
    }
    const client = config.client as {
      from: (table: string) => {
        upsert: (
          rows: Array<Record<string, unknown>>,
          opts: { onConflict: string }
        ) => Promise<{ error: unknown }>;
      };
    };
    const rows = items.map((m) => ({
      user_id: userId,
      url: m.url,
      type: m.type,
      mime_type: m.mimeType ?? null,
      size: m.size ?? null,
      storage_path: m.storagePath,
      updated_at: toIso(m.updatedAt),
    }));
    const { error } = await client
      .from(SYNC_MEDIA_TABLE)
      .upsert(rows, { onConflict: 'user_id,url' });
    return error ? { error } : {};
  } catch (error) {
    return { error };
  }
}

export { entityKey };
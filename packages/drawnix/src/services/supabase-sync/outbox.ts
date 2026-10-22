/**
 * 同步 Outbox（openspec refactor-cloud-native-sync Phase A）
 *
 * 本地写入事件的持久化队列：先落盘再推送，成功才出队——
 * - 离线/云端不可达时累积，恢复在线按序回放；
 * - 页面崩溃/关闭不丢变更（下次启动回放）；
 * - 只记键不记内容，推送时从本地缓存现读（天然最新）。
 *
 * 独立 IndexedDB 库（aitu-sync-outbox），避免与 aitu-app/aitu-workspace 的
 * 版本升级协调；single store，keyPath 'key'（`${entityType}:${entityId}`）。
 */

const OUTBOX_DB_NAME = 'aitu-sync-outbox';
const OUTBOX_DB_VERSION = 1;
const OUTBOX_STORE = 'outbox';

export interface OutboxEntry {
  /** `${entityType}:${entityId}`；entityId '*' 表示类型级脏标记 */
  key: string;
  entityType: string;
  entityId: string;
  /** 最新一次本地变更时间（epoch ms） */
  updatedAt: number;
  /** 首次入队时间（跨多次合并保留） */
  enqueuedAt: number;
  /** 连续推送失败次数（指数退避依据） */
  failCount: number;
  /** 最近一次推送尝试时间（退避窗口判定） */
  lastAttemptAt?: number;
  lastError?: string;
}

export function buildOutboxKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DB_NAME, OUTBOX_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'key' });
        store.createIndex('entityType', 'entityType', { unique: false });
      }
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(OUTBOX_STORE, mode);
      const store = transaction.objectStore(OUTBOX_STORE);
      let result: T | undefined;
      const request = fn(store);
      if (request) {
        request.onsuccess = () => {
          result = request.result;
        };
      }
      transaction.oncomplete = () => resolve(result as T);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** 入队/合并：同键保留最早 enqueuedAt 与既有失败计数，updatedAt 取较新 */
export async function enqueueOutbox(
  entityType: string,
  entityId: string,
  updatedAt: number = Date.now()
): Promise<void> {
  const key = buildOutboxKey(entityType, entityId);
  const existing = await withStore<OutboxEntry | undefined>('readonly', (store) =>
    store.get(key) as IDBRequest<OutboxEntry | undefined>
  );
  const entry: OutboxEntry = {
    key,
    entityType,
    entityId,
    updatedAt: Math.max(updatedAt, existing?.updatedAt ?? 0),
    enqueuedAt: existing?.enqueuedAt ?? Date.now(),
    failCount: existing?.failCount ?? 0,
    lastError: existing?.lastError,
  };
  await withStore('readwrite', (store) => {
    store.put(entry);
  });
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  const entries = await withStore<OutboxEntry[]>('readonly', (store) =>
    store.getAll() as IDBRequest<OutboxEntry[]>
  );
  return (entries ?? []).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

export async function outboxCount(): Promise<number> {
  const entries = await listOutbox();
  return entries.length;
}

/** 推送成功后批量出队 */
export async function removeOutboxKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  await withStore('readwrite', (store) => {
    for (const key of keys) {
      store.delete(key);
    }
  });
}

/** 推送失败：累加失败计数并记录错误（退避依据） */
export async function markOutboxFailed(
  keys: string[],
  error: unknown
): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  await withStore('readwrite', (store) => {
    for (const key of keys) {
      const put = (entry: OutboxEntry) => {
        store.put({
          ...entry,
          failCount: entry.failCount + 1,
          lastAttemptAt: Date.now(),
          lastError: message,
        });
      };
      const request = store.get(key) as IDBRequest<OutboxEntry | undefined>;
      request.onsuccess = () => {
        const existing = request.result;
        if (existing) {
          put(existing);
        }
      };
    }
  });
}

/** 清空（测试与登出用） */
export async function clearOutbox(): Promise<void> {
  await withStore('readwrite', (store) => {
    store.clear();
  });
}

/**
 * 缓存 Blob 的 IndexedDB 兜底存储
 *
 * 背景：媒体缓存的主数据源是 Cache Storage（配合 Service Worker 拦截虚拟 URL）。
 * 但 Cache Storage API 只在安全上下文（HTTPS / localhost）可用 —— 纯 HTTP 内网部署
 * （如 http://10.37.80.25:8088）既没有 Service Worker 也没有 caches 对象。
 * 此时 `unifiedCacheService.cacheMediaFromBlob` 只能写 IDB 元数据、丢真实二进制，
 * 画布/素材库里的虚拟 URL 全部 404。
 *
 * 本模块提供与 Cache Storage 同构的「url → Blob」持久化（独立小库，keyPath url），
 * 仅作为 caches API 缺失时的降级数据源使用；安全上下文下不写入，避免双份存储。
 *
 * 实现说明：记录以「ArrayBuffer 字节 + mimeType」形式存储而非直接存 Blob ——
 * Blob 的 IndexedDB structured clone 在各实现/测试环境（jsdom + fake-indexeddb）
 * 兼容性不一致，字节数组是跨环境最稳的存储形态。
 */

const FALLBACK_DB_NAME = 'drawnix-cache-blob-fallback';
const FALLBACK_DB_VERSION = 1;
const FALLBACK_STORE_NAME = 'media-blobs';

interface BlobRecord {
  url: string;
  bytes: ArrayBuffer;
  type: string;
  cachedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(FALLBACK_DB_NAME, FALLBACK_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FALLBACK_STORE_NAME)) {
        db.createObjectStore(FALLBACK_STORE_NAME, { keyPath: 'url' });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      console.warn('[CacheBlobFallback] Failed to open database:', request.error);
      dbPromise = null;
      resolve(null);
    };
  });

  return dbPromise;
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return openDB().then((db) => {
    if (!db) {
      return null;
    }
    return new Promise<T | null>((resolve) => {
      try {
        const transaction = db.transaction(FALLBACK_STORE_NAME, mode);
        const store = transaction.objectStore(FALLBACK_STORE_NAME);
        const request = run(store);
        let result: T | null = null;
        let settled = false;
        const finish = (value: T | null) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        request.onsuccess = () => {
          result = (request.result as T) ?? null;
          // 只读操作可以直接返回；写操作需等事务提交，避免紧随的读看不到新数据
          if (mode === 'readonly') {
            finish(result);
          }
        };
        request.onerror = () => {
          console.warn('[CacheBlobFallback] Request failed:', request.error);
          finish(null);
        };
        transaction.oncomplete = () => {
          if (mode !== 'readonly') {
            finish(result);
          }
        };
        transaction.onerror = () => {
          console.warn(
            '[CacheBlobFallback] Transaction failed:',
            transaction.error
          );
          finish(null);
        };
        transaction.onabort = () => {
          console.warn(
            '[CacheBlobFallback] Transaction aborted:',
            transaction.error
          );
          finish(null);
        };
      } catch (error) {
        console.warn('[CacheBlobFallback] Transaction failed:', error);
        resolve(null);
      }
    });
  });
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  // 用 FileReader 而非 blob.arrayBuffer()：Node/jsdom 组合下各 Blob 实现
  // 的 arrayBuffer 可用性不一致（vitest.setup 已统一 Blob/FileReader 为 jsdom 实现）
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error('readAsArrayBuffer failed'));
    reader.readAsArrayBuffer(blob);
  });
}

/** 写入一个 url → Blob 记录（幂等覆盖） */
export async function putCacheBlobFallback(
  url: string,
  blob: Blob
): Promise<boolean> {
  if (!url || !blob) {
    return false;
  }
  try {
    const bytes = await blobToArrayBuffer(blob);
    if (!bytes || bytes.byteLength === 0) {
      return false;
    }
    const record: BlobRecord = {
      url,
      bytes,
      type: blob.type || 'application/octet-stream',
      cachedAt: Date.now(),
    };
    const result = await withStore('readwrite', (store) => store.put(record));
    return result !== null;
  } catch (error) {
    console.warn('[CacheBlobFallback] Failed to persist blob:', url, error);
    return false;
  }
}

/** 读取指定 url 的 Blob，不存在或失败返回 null */
export async function getCacheBlobFallback(url: string): Promise<Blob | null> {
  if (!url) {
    return null;
  }
  try {
    const record = await withStore<BlobRecord | undefined>(
      'readonly',
      (store) => store.get(url)
    );
    if (record && record.bytes && record.bytes.byteLength > 0) {
      return new Blob([record.bytes], {
        type: record.type || 'application/octet-stream',
      });
    }
    return null;
  } catch (error) {
    console.warn('[CacheBlobFallback] Failed to read blob:', url, error);
    return null;
  }
}

/** 删除指定 url 的 Blob 记录 */
export async function deleteCacheBlobFallback(url: string): Promise<void> {
  if (!url) {
    return;
  }
  await withStore('readwrite', (store) => store.delete(url));
}

/** 清空全部降级 Blob 记录 */
export async function clearCacheBlobFallbacks(): Promise<void> {
  const db = await openDB();
  if (!db) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(FALLBACK_STORE_NAME, 'readwrite');
      transaction.objectStore(FALLBACK_STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 返回已存在的全部降级 Blob url（用于素材库列表校验等） */
export async function listCacheBlobFallbackUrls(): Promise<string[]> {
  const db = await openDB();
  if (!db) {
    return [];
  }
  return new Promise<string[]>((resolve) => {
    try {
      const transaction = db.transaction(FALLBACK_STORE_NAME, 'readonly');
      const request = transaction.objectStore(FALLBACK_STORE_NAME).getAllKeys();
      request.onsuccess = () => resolve((request.result as string[]) || []);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

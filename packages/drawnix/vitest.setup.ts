// Vitest setup file
// Add any global test setup here

// jsdom 无原生 IndexedDB，测试环境统一使用 fake-indexeddb 提供
import 'fake-indexeddb/auto';

// Node 22+ 自带实验性的 globalThis.localStorage/sessionStorage，在未启用
// --localstorage-file 时表现为 undefined，并会遮蔽 jsdom 环境里的可用实现
// （`'localStorage' in window` 为 true 但取值为 undefined），导致依赖存储的
// 测试报 "No available storage method" / "reading 'getItem'"。
// 这里确保 localStorage/sessionStorage 始终可用：jsdom 实现可用则复用，
// 否则安装一个内存版兜底（Node 20 的 CI 环境走 jsdom 原生实现，本片段为空操作）。
function installStorageFallback(name: 'localStorage' | 'sessionStorage'): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const jsdomWindow =
    typeof window !== 'undefined'
      ? (window as unknown as Record<string, unknown>)
      : undefined;
  const existing = (jsdomWindow?.[name] ?? g[name]) as
    | { getItem?: unknown }
    | undefined;

  if (existing && typeof existing.getItem === 'function') {
    return;
  }

  const store = new Map<string, string>();
  const storage = {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
  };

  if (jsdomWindow) {
    Object.defineProperty(jsdomWindow, name, {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(g, name, {
    value: storage,
    configurable: true,
    writable: true,
  });
}

installStorageFallback('localStorage');
installStorageFallback('sessionStorage');

// Node 20（CI 镜像）下全局 Blob 与 jsdom 的 Blob 是不同实现，
// FileReader.readAsDataURL/readAsArrayBuffer 校验参数 instanceof 时拒绝
// Node 全局 Blob（"parameter 1 is not of type 'Blob'"）。统一为 jsdom 的实现。
const g = globalThis as unknown as Record<string, unknown>;
const jsdomWinForBlob =
  typeof window !== 'undefined'
    ? (window as unknown as Record<string, unknown>)
    : undefined;
if (jsdomWinForBlob) {
  for (const name of ['Blob', 'FileReader'] as const) {
    const jsdomValue = jsdomWinForBlob[name] as unknown;
    const globalValue = g[name];
    if (jsdomValue && globalValue !== jsdomValue) {
      Object.defineProperty(g, name, {
        value: jsdomValue,
        configurable: true,
        writable: true,
      });
    }
  }
}
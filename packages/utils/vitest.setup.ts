// Vitest setup file
// Add any global test setup here

// Node 22+ 自带实验性的 globalThis.localStorage/sessionStorage，在未启用
// --localstorage-file 时表现为 undefined，并遮蔽 jsdom 环境里的可用实现，
// 导致 jsdom 测试中 localStorage.clear() 等读取 undefined 失败。
// 这里确保 localStorage/sessionStorage 可用：jsdom 实现可用则复用，否则安装内存版兜底。
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
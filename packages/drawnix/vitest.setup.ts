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

// 单元测试统一走旧存储路径（openspec remove-local-persistence）：云端直连路径
// 的行为由 cloud-direct-store / repository 的独立单测与 E2E 覆盖，既有存储服务
// 单测依赖 IndexedDB 旧路径语义。flag 默认开启（生产行为），测试环境显式回退。
if (typeof localStorage !== 'undefined' && localStorage.getItem) {
  if (localStorage.getItem('cloud_only_storage') === null) {
    localStorage.setItem('cloud_only_storage', '0');
  }
}

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

// undici 的 Response.prototype.blob() 返回 undici 内部 Blob（与 jsdom 实现不同源），
// 传入 jsdom 的 FileReader/FormData 时被 instanceof 校验拒绝。统一转换为 jsdom Blob。
const undiciResponse = (globalThis as unknown as { Response?: unknown }).Response as
  | (new (body?: BodyInit | null, init?: ResponseInit) => Response)
  | undefined;
const jsdomBlobCtor = jsdomWinForBlob?.Blob as
  | (new (parts?: BlobPart[], options?: BlobPropertyBag) => Blob)
  | undefined;
if (undiciResponse && jsdomWinForBlob && jsdomBlobCtor) {
  const originalBlob = undiciResponse.prototype.blob;
  if (originalBlob) {
    Object.defineProperty(undiciResponse.prototype, 'blob', {
      value: async function blob(this: Response): Promise<Blob> {
        const native = await originalBlob.call(this);
        if (native instanceof jsdomBlobCtor) {
          return native;
        }
        return new jsdomBlobCtor([new Uint8Array(await native.arrayBuffer())], {
          type: native.type,
        });
      },
      configurable: true,
      writable: true,
    });
  }
}

// 在部分 Node 版本 + jsdom 组合下，SubtleCrypto.encrypt/decrypt 对传入的
// 缓冲区参数做 instanceof 校验会失败（"Nth argument is not instance of
// ArrayBuffer, Buffer, TypedArray, or DataView"）。这是 settings-manager
// 加密自检的已捕获路径，但运行时噪音可能被 vitest 计为未处理错误导致偶发
// exit 1。这里统一把参数归一化为标准 BufferSource。
const gWeb = globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } };
const gW = gWeb.crypto?.subtle;
if (gW && typeof gW.decrypt === 'function') {
  const originalDecrypt = gW.decrypt.bind(gW);
  const originalEncrypt = gW.encrypt?.bind(gW);
  const toBufferSource = (x: unknown): BufferSource | undefined => {
    if (
      x instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && x instanceof SharedArrayBuffer) ||
      ArrayBuffer.isView(x)
    ) {
      return x as BufferSource;
    }
    if (x == null) {
      return undefined;
    }
    try {
      return new Uint8Array(x as ArrayLike<number>);
    } catch {
      return undefined;
    }
  };
  gW.decrypt = ((algorithm, key, data) => {
    const norm = toBufferSource(data);
    if (norm === undefined) {
      throw new TypeError('invalid BufferSource');
    }
    return originalDecrypt(
      algorithm,
      key,
      norm
    );
  }) as typeof gW.decrypt;
  if (originalEncrypt) {
    gW.encrypt = ((algorithm, key, data) => {
      const norm = toBufferSource(data);
      if (norm === undefined) {
        throw new TypeError('invalid BufferSource');
      }
      return originalEncrypt(algorithm, key, norm);
    }) as typeof gW.encrypt;
  }
}
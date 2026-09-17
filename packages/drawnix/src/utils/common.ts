import {
  IS_APPLE,
  IS_MAC,
  PlaitBoard,
  PlaitElement,
  toImage,
  ToImageOptions,
} from '@plait/core';

const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lB5Z6wAAAABJRU5ErkJggg==';
const IMAGE_URL_KEYS = new Set(['href', 'imageurl', 'src', 'url']);
const DOM_IMAGE_URL_ATTRIBUTES = ['src', 'href', 'xlink:href'];
const MAX_TO_IMAGE_URL_SCAN_DEPTH = 8;
const noop = () => undefined;

type MemoryLogWindow = Window & {
  __memoryLog?: {
    track?: (label: string) => () => void;
  };
};

const toImageFallbackUrlRefs = new Map<string, number>();
let toImageFetchPatchDepth = 0;
let originalToImageFetch: typeof window.fetch | null = null;
let patchedToImageFetch: typeof window.fetch | null = null;

function getFetchUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function normalizeImageUrlCandidates(url: string): string[] {
  const trimmed = url.trim();
  if (!trimmed) {
    return [];
  }

  const candidates = [trimmed];
  if (typeof window !== 'undefined') {
    try {
      candidates.push(new URL(trimmed, window.location.href).href);
    } catch {
      // Keep the raw URL only.
    }
  }
  return Array.from(new Set(candidates));
}

function collectImageUrls(
  value: unknown,
  urls: Set<string>,
  seen: WeakSet<object>,
  depth = 0
): void {
  if (depth > MAX_TO_IMAGE_URL_SCAN_DEPTH || value == null) {
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectImageUrls(item, urls, seen, depth + 1);
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && IMAGE_URL_KEYS.has(key.toLowerCase())) {
      for (const candidate of normalizeImageUrlCandidates(item)) {
        urls.add(candidate);
      }
      continue;
    }

    collectImageUrls(item, urls, seen, depth + 1);
  }
}

function addImageUrl(urls: Set<string>, url: string | null | undefined): void {
  if (!url) {
    return;
  }

  for (const candidate of normalizeImageUrlCandidates(url)) {
    urls.add(candidate);
  }
}

function collectDomImageUrlsFromElement(
  element: PlaitElement,
  urls: Set<string>
): void {
  try {
    if (!PlaitElement.hasMounted(element)) {
      return;
    }

    const elementG = PlaitElement.getElementG(element);
    const imageNodes = elementG.querySelectorAll('img, image');

    imageNodes.forEach((node) => {
      DOM_IMAGE_URL_ATTRIBUTES.forEach((attribute) => {
        addImageUrl(urls, node.getAttribute(attribute));
      });

      if (
        typeof HTMLImageElement !== 'undefined' &&
        node instanceof HTMLImageElement
      ) {
        addImageUrl(urls, node.currentSrc);
      }
    });
  } catch {
    // DOM fallback discovery is best effort; element data scanning still applies.
  }
}

function collectMountedImageUrls(
  elements: PlaitElement[],
  urls: Set<string>
): void {
  for (const element of elements) {
    collectDomImageUrlsFromElement(element, urls);
  }
}

function getToImageFallbackUrls(
  board: PlaitBoard,
  options: ToImageOptions
): Set<string> {
  const urls = new Set<string>();
  const elements = ((options as ToImageOptions & { elements?: PlaitElement[] })
    .elements || board.children) as PlaitElement[];
  collectImageUrls(elements, urls, new WeakSet<object>());
  collectMountedImageUrls(elements, urls);
  return urls;
}

function addFallbackUrls(urls: Set<string>): void {
  urls.forEach((url) => {
    toImageFallbackUrlRefs.set(url, (toImageFallbackUrlRefs.get(url) || 0) + 1);
  });
}

function removeFallbackUrls(urls: Set<string>): void {
  urls.forEach((url) => {
    const nextCount = (toImageFallbackUrlRefs.get(url) || 0) - 1;
    if (nextCount > 0) {
      toImageFallbackUrlRefs.set(url, nextCount);
    } else {
      toImageFallbackUrlRefs.delete(url);
    }
  });
}

function shouldFallbackToTransparentImage(input: RequestInfo | URL): boolean {
  const url = getFetchUrl(input);
  if (!url) {
    return false;
  }
  return normalizeImageUrlCandidates(url).some((candidate) =>
    toImageFallbackUrlRefs.has(candidate)
  );
}

function createTransparentPngResponse(): Response {
  const binary = atob(TRANSPARENT_PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
    },
  });
}

// @plait/core 的 toImage 会在内部 fetch(svg image href).then(...)，
// fetch 失败时不会 reject 外层 Promise，容易产生未捕获异常并挂起导出。
// 这里仅在 toImage 运行期间、且仅针对当前画布图片 URL，降级为透明占位图。
function installToImageFetchFallback(urls: Set<string>): () => void {
  if (typeof window === 'undefined' || urls.size === 0) {
    return noop;
  }

  addFallbackUrls(urls);

  if (toImageFetchPatchDepth === 0) {
    originalToImageFetch = window.fetch;
    patchedToImageFetch = async function patchedFetch(input, init) {
      const fetchImpl = originalToImageFetch || window.fetch;
      const shouldFallback = shouldFallbackToTransparentImage(input);
      try {
        const response = await fetchImpl.call(window, input, init);
        if (shouldFallback && !response.ok) {
          return createTransparentPngResponse();
        }
        return response;
      } catch (error) {
        if (shouldFallback) {
          return createTransparentPngResponse();
        }
        throw error;
      }
    };
    window.fetch = patchedToImageFetch;
  }

  toImageFetchPatchDepth += 1;

  return () => {
    removeFallbackUrls(urls);
    toImageFetchPatchDepth = Math.max(0, toImageFetchPatchDepth - 1);
    if (toImageFetchPatchDepth === 0) {
      if (patchedToImageFetch && window.fetch === patchedToImageFetch) {
        window.fetch = originalToImageFetch || window.fetch;
      }
      originalToImageFetch = null;
      patchedToImageFetch = null;
      toImageFallbackUrlRefs.clear();
    }
  };
}

export async function safeToImage(
  board: PlaitBoard,
  options: ToImageOptions = {}
) {
  const cleanup = installToImageFetchFallback(
    getToImageFallbackUrls(board, options)
  );
  try {
    return await toImage(board, options);
  } finally {
    cleanup();
  }
}

/**
 * Convert Plait board to image (Plait-specific)
 *
 * @param board - Plait board instance
 * @param options - Image export options
 * @returns Promise resolving to image data URL
 */
export const boardToImage = (
  board: PlaitBoard,
  options: ToImageOptions = {}
) => {
  return safeToImage(board, {
    fillStyle: 'transparent',
    inlineStyleClassNames: '.extend,.emojis,.text',
    padding: 20,
    ratio: 4,
    ...options,
  });
};

/**
 * Format keyboard shortcut for current platform (Plait-specific)
 *
 * @param shortcut - Shortcut string with placeholders
 * @returns Platform-specific shortcut string
 */
export const getShortcutKey = (shortcut: string): string => {
  if (IS_APPLE || IS_MAC) {
    return shortcut
      .replace(/\bCtrlOrCmd\b/gi, 'Cmd')
      .replace(/\bAlt\b/i, 'Option');
  }
  return shortcut.replace(/\bCtrlOrCmd\b/gi, 'Ctrl');
};

// ==================== 内存监控 ====================

/**
 * 轻量级内存追踪
 * 使用全局 __memoryLog（由 crash-logger 初始化），如果可用
 * 只在内存变化超过 50MB 时才输出日志，避免干扰正常使用
 *
 * @param label - 操作名称，如 "图片合并"、"批量导入"
 * @returns 结束函数，在操作完成后调用
 *
 * @example
 * const end = trackMemory('图片合并');
 * await mergeImages();
 * end(); // 只在内存变化 > 50MB 时输出日志
 */
export function trackMemory(label: string): () => void {
  const tracker = (window as MemoryLogWindow).__memoryLog?.track;
  return tracker ? tracker(label) : noop;
}

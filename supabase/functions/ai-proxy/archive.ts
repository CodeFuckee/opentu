/**
 * ai-proxy 响应归档纯函数（无网络依赖，可单测）
 *
 * 职责：
 * - 白名单 base64 字段（b64_json / b64 / base64）与 dataURL 值的识别/收集
 * - base64 解码、图片 MIME 魔数嗅探、扩展名推导、output 存储路径拼接
 * - 深拷贝替换（base64 值 → 存储路径），不污染原对象
 * - 异步任务响应"终态"判定（成功/失败为终态，中间态不是）
 */

/** 白名单 base64 字段名（大小写不敏感，匹配时统一转小写） */
export const BASE64_KEYS: ReadonlySet<string> = new Set([
  'b64_json',
  'b64',
  'base64',
]);

/** data URL 前缀 */
const DATA_URL_PREFIX = 'data:';

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

const FALLBACK_EXTENSION = 'bin';

/** 用户名清洗（与前端 sanitizeUsername 一致：小写 + 白名单字符，其余替换为 _） */
const USERNAME_SAFE_CHARS = /[^a-z0-9._-]/g;
const MAX_USERNAME_LENGTH = 64;

/** 判断值是否为 data URL 字符串 */
export function isDataUrlValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(DATA_URL_PREFIX);
}

/**
 * 深度遍历未知结构，收集"需要转存的 base64 值"：
 * - 字段名命中 BASE64_KEYS（大小写不敏感）且值为字符串
 * - 任意位置的 data URL 值
 * 返回去重后的值列表（保持首次出现顺序）。
 */
export function collectBase64Values(value: unknown): string[] {
  const seen = new Set<string>();
  walk(value, seen);
  return Array.from(seen);
}

function walk(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (isDataUrlValue(value)) {
      out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, out);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' && BASE64_KEYS.has(key.toLowerCase())) {
        out.add(item);
        continue;
      }
      walk(item, out);
    }
  }
}

/** base64 字符串解码为字节 */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 从待转存值中提取可解码的 base64 载荷：
 * - dataURL：仅接受 ;base64 编码，剥离 data 头返回载荷；否则返回 null（跳过）
 * - 普通字符串：原样返回
 */
export function extractBase64Payload(value: string): string | null {
  if (!isDataUrlValue(value)) {
    return value;
  }
  const comma = value.indexOf(',');
  if (comma < 0) {
    return null;
  }
  const header = value.slice(0, comma);
  if (!/;base64$/i.test(header)) {
    return null;
  }
  return value.slice(comma + 1);
}

/** 从 data URL 提取 MIME 类型（缺失时返回 null） */
export function extractMimeFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^;,]*)(;base64)?,/.exec(dataUrl);
  if (!match || !match[1]) {
    return null;
  }
  return match[1].trim() || null;
}

/**
 * 图片二进制 MIME 魔数嗅探。
 * 无法识别时回退 image/png（new-api 图片类响应以位图为主）。
 */
export function sniffMimeFromBytes(bytes: Uint8Array): string {
  const len = bytes.length;
  const ascii = (offset: number, text: string): boolean => {
    if (len < offset + text.length) {
      return false;
    }
    for (let i = 0; i < text.length; i += 1) {
      if (bytes[offset + i] !== text.charCodeAt(i)) {
        return false;
      }
    }
    return true;
  };

  if (
    len >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (len >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) {
    return 'image/gif';
  }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    return 'image/webp';
  }
  if (ascii(4, 'ftyp') && ascii(8, 'avif')) {
    return 'image/avif';
  }
  return 'image/png';
}

/** MIME → 扩展名（未知回退 bin） */
export function mimeToExtension(mimeType: string): string {
  return MIME_TO_EXTENSION[mimeType.trim().toLowerCase()] ?? FALLBACK_EXTENSION;
}

export function sanitizeUsername(username: string): string {
  return username
    .trim()
    .toLowerCase()
    .replace(USERNAME_SAFE_CHARS, '_')
    .slice(0, MAX_USERNAME_LENGTH);
}

/** 拼接 output 存储路径：{username}/{YYYY-MM-DD}/output-{hash}.{ext} */
export function buildOutputStoragePath(
  username: string,
  dateStr: string,
  hash: string,
  extension: string
): string {
  const file = `output-${hash}.${extension}`;
  const usernamePart = username.trim() ? `${username.trim()}/` : '';
  return `${usernamePart}${dateStr}/${file}`;
}

/** 对二进制内容计算 SHA-256（十六进制小写） */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('crypto.subtle is not available');
  }
  const digest = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 用存储路径替换 JSON 中的 base64 值（深拷贝，不修改原对象）。
 * 只替换出现在 pathByValue 中的值；其余保留。
 */
export function replaceBase64WithPaths(
  value: unknown,
  pathByValue: ReadonlyMap<string, string>
): unknown {
  function replaceValue(current: unknown): unknown {
    if (typeof current === 'string' && pathByValue.has(current)) {
      return pathByValue.get(current);
    }
    if (Array.isArray(current)) {
      return current.map((item) => replaceValue(item));
    }
    if (current && typeof current === 'object') {
      const next: Record<string, unknown> = {};
      for (const key of Object.keys(current as Record<string, unknown>)) {
        next[key] = replaceValue((current as Record<string, unknown>)[key]);
      }
      return next;
    }
    return current;
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return replaceValue(value);
}

/** 响应中的终态状态值（大小写不敏感） */
const TERMINAL_STATUSES = new Set([
  'completed',
  'complete',
  'success',
  'succeeded',
  'successful',
  'done',
  'failed',
  'failure',
  'fail',
  'cancelled',
  'canceled',
  'expired',
  'error',
]);

/**
 * 异步任务响应是否达到终态（成功或失败均算终态）。
 * 检查 body 顶层与 data 层的 status / state / task_status 字段。
 */
export function isTerminalAsyncState(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }
  const sources = [body as Record<string, unknown>, (body as any)?.data];
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    for (const key of ['status', 'state', 'task_status', 'code']) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === 'string' && TERMINAL_STATUSES.has(value.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}
/**
 * task-supabase-archive 核心纯函数
 *
 * 职责（全部为纯函数/可单测逻辑，不依赖 Supabase 客户端）：
 * - dataURL 识别 / 解析 / 解码为 Blob
 * - MIME → 扩展名映射
 * - 用户名清洗（目录安全）、本地日期、存储路径拼接
 * - SHA-256 哈希（crypto.subtle）
 * - 从任务参数中提取文件条目（去重）并生成 dataURL → 存储路径 映射
 * - 用存储路径替换参数中的 dataURL（深拷贝，不污染原对象）
 */

/** data URL 前缀 */
const DATA_URL_PREFIX = 'data:';

/** MIME → 扩展名映射表 */
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-m4a': 'm4a',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/** 未知 MIME 的兜底扩展名 */
const FALLBACK_EXTENSION = 'bin';

/** 用户名清洗后的最大长度 */
const MAX_USERNAME_LENGTH = 64;

/** 目录安全字符白名单 */
const USERNAME_SAFE_CHARS = /[^a-z0-9._-]/g;

/**
 * 判断一个值是否为 data URL 字符串。
 */
export function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(DATA_URL_PREFIX);
}

export interface ParsedDataUrl {
  /** MIME 类型（缺失时回退 application/octet-stream） */
  mimeType: string;
  /** 是否 base64 编码 */
  isBase64: boolean;
  /** 编码后的数据体（base64 串或 raw 编码串） */
  data: string;
}

/**
 * 解析 data URL：`data:[mime][;base64],<data>`。
 * 非法输入抛错。
 */
export function parseDataUrl(dataUrl: string): ParsedDataUrl {
  // 等价于 /s 标志（target=es2015 不支持 dotAll）：使 . 匹配换行
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) {
    throw new Error(`Invalid data URL: ${dataUrl.slice(0, 40)}`);
  }
  const mimeType = match[1]?.trim() || 'application/octet-stream';
  return {
    mimeType,
    isBase64: Boolean(match[2]),
    data: match[3] ?? '',
  };
}

/** base64 字符串解码为 Uint8Array */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 把 data URL 解码为 Blob（保留 MIME 类型）。
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const { mimeType, isBase64, data } = parseDataUrl(dataUrl);
  const bytes = isBase64
    ? base64ToBytes(data)
    : new TextEncoder().encode(decodeURIComponent(data));
  return new Blob([bytes], { type: mimeType });
}

/**
 * MIME 类型 → 文件扩展名（未知回退 bin）。
 */
export function mimeToExtension(mimeType: string): string {
  return MIME_TO_EXTENSION[mimeType.trim().toLowerCase()] ?? FALLBACK_EXTENSION;
}

/**
 * 本地时区日期字符串 YYYY-MM-DD（bucket 路径目录用）。
 */
export function getLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 清洗用户名用于 bucket 目录：
 * - 转小写
 * - 仅保留 [a-z0-9._-]，其余替换为下划线
 * - 截断到 MAX_USERNAME_LENGTH
 */
export function sanitizeUsername(username: string): string {
  return username
    .trim()
    .toLowerCase()
    .replace(USERNAME_SAFE_CHARS, '_')
    .slice(0, MAX_USERNAME_LENGTH);
}

/**
 * 拼接存储路径：{username}/{YYYY-MM-DD}/input-{hash}.{ext}。
 * 用户名为空时省略用户名目录。
 */
export function buildStoragePath(
  username: string,
  dateStr: string,
  hash: string,
  extension: string
): string {
  const file = `input-${hash}.${extension}`;
  const usernamePart = username.trim() ? `${username.trim()}/` : '';
  return `${usernamePart}${dateStr}/${file}`;
}

/**
 * 对二进制内容计算 SHA-256（十六进制小写）。
 * 使用 Web Crypto；测试环境通过全局 crypto 注入。
 */
export async function sha256Hex(data: BufferSource): Promise<string> {
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
 * 读取 Blob 二进制内容（兼容不支持 arrayBuffer() 的环境，如部分 jsdom）。
 */
function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * 对 Blob 内容计算 SHA-256。
 */
export async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await readBlobAsArrayBuffer(blob);
  return sha256Hex(buffer);
}

/**
 * 文件条目：从任务参数中提取的一个待上传文件。
 */
export interface ArchiveFileEntry {
  /** 原始 data URL（去重键） */
  dataUrl: string;
  /** 解码后的 Blob */
  blob: Blob;
  /** MIME 类型 */
  mimeType: string;
  /** 由 MIME 推导的扩展名 */
  extension: string;
  /** 内容 SHA-256 */
  hash: string;
  /** 存储路径：{username}/{date}/input-{hash}.{ext} */
  storagePath: string;
}

/**
 * 深度遍历未知结构，收集所有 data URL 字符串。
 * 返回去重后的 data URL 列表（保持首次出现顺序）。
 */
export function collectDataUrls(value: unknown, seen: Set<string>): void {
  if (isDataUrl(value)) {
    seen.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectDataUrls(item, seen);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      collectDataUrls((value as Record<string, unknown>)[key], seen);
    }
  }
}

/**
 * 从任务参数中提取文件条目：
 * - 收集全部 data URL（去重）
 * - 每个 data URL 解码 → 哈希 → 生成存储路径
 */
export async function buildFileEntries(
  params: Record<string, unknown>,
  username: string,
  dateStr: string
): Promise<{ entries: ArchiveFileEntry[]; pathByDataUrl: Map<string, string> }> {
  const seen = new Set<string>();
  collectDataUrls(params, seen);

  const entries: ArchiveFileEntry[] = [];
  const pathByDataUrl = new Map<string, string>();

  for (const dataUrl of seen) {
    const { mimeType } = parseDataUrl(dataUrl);
    const blob = dataUrlToBlob(dataUrl);
    const hash = await hashBlob(blob);
    const extension = mimeToExtension(mimeType);
    const storagePath = buildStoragePath(username, dateStr, hash, extension);
    entries.push({ dataUrl, blob, mimeType, extension, hash, storagePath });
    pathByDataUrl.set(dataUrl, storagePath);
  }

  return { entries, pathByDataUrl };
}

/**
 * 用存储路径替换任务参数中的 data URL（深拷贝，不修改原对象）。
 * 只替换出现在 pathByDataUrl 中的 data URL；其余值原样保留。
 */
export function toParamsWithFilePaths(
  params: Record<string, unknown>,
  pathByDataUrl: ReadonlyMap<string, string>
): Record<string, unknown> {
  function replaceValue(value: unknown): unknown {
    if (isDataUrl(value)) {
      return pathByDataUrl.get(value) ?? value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => replaceValue(item));
    }
    if (value && typeof value === 'object') {
      const next: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>)) {
        next[key] = replaceValue((value as Record<string, unknown>)[key]);
      }
      return next;
    }
    return value;
  }

  return replaceValue(params) as Record<string, unknown>;
}

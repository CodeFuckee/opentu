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
 * - （响应归档）从上游响应 JSON 中收集 base64 值（b64_json/b64/base64/dataURL）、
 *   输出存储路径（与输入同一规则，无 input-/output- 前缀：输出图可直接作为下一任务输入）、
 *   深拷贝替换 base64 → 路径
 */

/** data URL 前缀 */
const DATA_URL_PREFIX = 'data:';

/** base64 白名单字段名（响应归档用，大小写不敏感，匹配时统一转小写） */
const BASE64_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  'b64_json',
  'b64',
  'base64',
]);

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
 * 拼接存储路径：{username}/{YYYY-MM-DD}/{hash}.{ext}。
 * 不带 input-/output- 前缀：输入图与输出图同规则命名，
 * 输出图可直接作为下一任务的输入（按内容哈希去重，天然复用）。
 * 用户名为空时省略用户名目录。
 */
export function buildStoragePath(
  username: string,
  dateStr: string,
  hash: string,
  extension: string
): string {
  const file = `${hash}.${extension}`;
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
  return readBlobAsArrayBufferSafe(blob);
}

/**
 * 读取 Blob 二进制内容（兼容不支持 arrayBuffer() 的环境，如部分 jsdom）。
 * 公开导出版本，供 service.ts fetch 回退分支复用。
 */
export function readBlobAsArrayBufferSafe(blob: Blob): Promise<ArrayBuffer> {
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
  /** 存储路径：{username}/{date}/{hash}.{ext} */
  storagePath: string;
}

/**
 * 从一个 Blob 构建文件条目（hash + 扩展名 + 存储路径）。
 * 供「fetch 远程/降级 URL 取 blob 后上传」的回退路径复用，
 * 与 buildFileEntries 中 dataURL 分支保持同一存储路径规则。
 */
export async function buildFileEntryFromBlob(
  sourceKey: string,
  blob: Blob,
  username: string,
  dateStr: string
): Promise<ArchiveFileEntry> {
  const hash = await hashBlob(blob);
  const mimeType = blob.type || 'application/octet-stream';
  const extension = mimeToExtension(mimeType);
  const storagePath = buildStoragePath(username, dateStr, hash, extension);
  return {
    dataUrl: sourceKey,
    blob,
    mimeType,
    extension,
    hash,
    storagePath,
  };
}

/**
 * 判断字符串是否为本地虚拟媒体路径（素材库 / 缓存），
 * 与 isVirtualMediaUrl 的前缀规则保持一致（仅同源相对路径形态）。
 */
export function isVirtualMediaPath(url: string): boolean {
  return (
    url.startsWith('/asset-library/') || url.startsWith('/__aitu_cache__/')
  );
}

/**
 * 深度遍历未知结构，收集所有虚拟媒体路径字符串（/asset-library/、/__aitu_cache__/）。
 * 与 collectDataUrls 互补：data URL 与虚拟路径都会进入待上传集合。
 */
export function collectVirtualMediaUrls(
  value: unknown,
  seen: Set<string>
): void {
  if (typeof value === 'string') {
    if (isVirtualMediaPath(value)) {
      seen.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectVirtualMediaUrls(item, seen);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      collectVirtualMediaUrls((value as Record<string, unknown>)[key], seen);
    }
  }
}

/**
 * 深度遍历未知结构，收集所有 http/https URL 字符串（去重，保持首次出现顺序）。
 * 与 collectDataUrls / collectVirtualMediaUrls 互补：
 * 归档函数原本只识别 data URL 与可解析为 base64 的虚拟 URL，遗漏远程 http URL
 * （粘贴远程参考图、素材库远程引用等），导致 file_paths 恒为空。
 */
export function collectHttpUrls(
  value: unknown,
  seen: Set<string>
): void {
  if (typeof value === 'string') {
    if (value.startsWith('http://') || value.startsWith('https://')) {
      seen.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectHttpUrls(item, seen);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      collectHttpUrls((value as Record<string, unknown>)[key], seen);
    }
  }
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

// ============================================================================
// 响应归档：上游响应 JSON 中的 base64 → huabu bucket
// ============================================================================

/**
 * 深度遍历未知结构，收集"需要转存的 base64 值"：
 * - 字段名命中 BASE64_RESPONSE_KEYS（b64_json/b64/base64，大小写不敏感）且值为字符串
 * - 任意位置的 dataURL 值
 * 返回去重后的值列表（保持首次出现顺序）。
 */
export function collectBase64Values(value: unknown): string[] {
  const seen = new Set<string>();
  walkResponseBase64(value, seen);
  return Array.from(seen);
}

function walkResponseBase64(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (isDataUrl(value)) {
      out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkResponseBase64(item, out);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (
        typeof item === 'string' &&
        BASE64_RESPONSE_KEYS.has(key.toLowerCase())
      ) {
        out.add(item);
        continue;
      }
      walkResponseBase64(item, out);
    }
  }
}

/**
 * 从待转存值中提取可解码的 base64 载荷：
 * - dataURL：仅接受 ;base64 编码，剥离 data 头返回载荷；否则返回 null（跳过）
 * - 普通字符串（b64_json 等字段）：原样返回
 */
export function extractBase64Payload(value: string): string | null {
  if (!isDataUrl(value)) {
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

/** base64 字符串解码为字节 */
export function decodeResponseBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 用存储路径替换 JSON 中的字符串值（深拷贝，不修改原对象）。
 * 只替换出现在 pathByValue 中的值；其余保留。
 * 与 replaceBase64WithPaths 的区别：顶层字符串也会被替换（通用替换，输入归档用）。
 */
export function replaceStringsWithPaths(
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

  return replaceValue(value);
}

/**
 * 用存储路径替换 JSON 中的 base64 值（深拷贝，不修改原对象）。
 * 只替换出现在 pathByValue 中的值；其余保留。
 */
export function replaceBase64WithPaths(
  value: unknown,
  pathByValue: ReadonlyMap<string, string>
): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return replaceStringsWithPaths(value, pathByValue);
}

/** 响应中的终态状态值（大小写不敏感；与 ai-proxy 归档语义一致） */
const TERMINAL_RESPONSE_STATUSES = new Set([
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
 * OpenAI 图片响应形状判定：body.data 为非空数组，且数组元素含 url 或 b64_json 字符串。
 * 用于补充 isTerminalResponseState：同步生图成功响应（{created, data:[{url}]}）没有
 * status/state 字段，但已产生媒体输出，同样应归档（写出 upstream_response）。
 */
export function hasOpenAIImageMedia(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) {
    return false;
  }
  return data.some(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      (typeof (item as Record<string, unknown>).url === 'string' ||
        typeof (item as Record<string, unknown>).b64_json === 'string')
  );
}

/**
 * 上游响应是否到达终态（成功或失败均算终态）。
 * 检查 body 顶层与 data 层的 status / state / task_status 字段。
 * （说明：响应归档只应在终态进行；中间态轮询（queued/processing）跳过）
 */
export function isTerminalResponseState(body: unknown): boolean {
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
      if (
        typeof value === 'string' &&
        TERMINAL_RESPONSE_STATUSES.has(value.toLowerCase())
      ) {
        return true;
      }
    }
  }
  return false;
}

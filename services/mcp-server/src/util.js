/**
 * 纯函数工具集
 *
 * 尺寸映射 / 用户名净化 / 摘要 / 图片魔数校验等——
 * 语义与前端保持一致：
 * - ASPECT_RATIO_TO_SIZE：packages/drawnix/src/services/media-api/utils.ts:141
 * - sanitizeUsername：packages/drawnix/src/services/task-supabase-archive/core.ts:134
 * - sniffImageMime：严格模式（未知字节返回 ''，不允许兜底——见知识库
 *   「校验型 sniffer 不能有兜底返回值」教训）
 */

import { createHash, randomUUID } from 'node:crypto';

/** 宽高比别名 → 像素尺寸（与前端 media-api/utils.ts 同表） */
export const ASPECT_RATIO_TO_SIZE = {
  '1x1': '1024x1024',
  '1x4': '512x2048',
  '4x1': '2048x512',
  '1x8': '256x2048',
  '8x1': '2048x256',
  '16x9': '1792x1024',
  '9x16': '1024x1792',
  '4x3': '1536x1152',
  '3x4': '1152x1536',
  '3x2': '1536x1024',
  '2x3': '1024x1536',
  '4x5': '1024x1280',
  '5x4': '1280x1024',
  '21x9': '1792x768',
};

/** 冒号写法别名（'1:1' → '1x1'） */
const COLON_ALIAS = {
  '1:1': '1x1',
  '1:4': '1x4',
  '4:1': '4x1',
  '1:8': '1x8',
  '8:1': '8x1',
  '2:3': '2x3',
  '3:2': '3x2',
  '3:4': '3x4',
  '4:3': '4x3',
  '4:5': '4x5',
  '5:4': '5x4',
  '9:16': '9x16',
  '16:9': '16x9',
  '21:9': '21x9',
};

/**
 * 规范化图片尺寸：比例别名 → 像素串；像素串原样放行；其余回退默认。
 */
export function normalizeImageSize(size, fallback = '1024x1024') {
  if (!size || size === 'auto') return fallback;
  const raw = String(size).trim().toLowerCase();
  const aliased = COLON_ALIAS[raw] || raw;
  if (ASPECT_RATIO_TO_SIZE[aliased]) return ASPECT_RATIO_TO_SIZE[aliased];
  if (/^\d{2,5}x\d{2,5}$/.test(raw)) return raw;
  return fallback;
}

/**
 * 用户名净化（存储路径首段），与前端 sanitizeUsername 同规则：
 * trim → 小写 → 非 [a-z0-9._-] 替换为 '_' → 截断 64。
 */
export function sanitizeUsername(username) {
  return (username || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .slice(0, 64);
}

/** 邮箱前缀（存储路径用户名来源） */
export function emailPrefix(email) {
  return (email || '').split('@')[0] || '';
}

/** 本地日期 YYYY-MM-DD（存储路径日期段） */
export function todayDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 严格图片魔数校验：png / jpeg / gif / webp，未知返回 ''。
 */
export function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return '';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return '';
}

export function mimeToExtension(mime) {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'png';
  }
}

/**
 * 规范化结果 URL：裸 base64（如 /9j/…、iVBOR…）→ data URL；其余原样。
 * 语义对齐前端 @aitu/utils normalizeImageDataUrl（packages/utils/src/url/index.ts:56）：
 * - data:/blob:/http(s):// 原样
 * - '/'|'./'|'../' 开头仅当命中 base64 签名才转换，否则视为相对路径原样
 * - base64 体校验（字符集 + 长度 ≥32）失败原样返回
 */
const BASE64_SIGNATURES = [
  ['/9j/', 'image/jpeg'],
  ['iVBOR', 'image/png'],
  ['R0lGOD', 'image/gif'],
  ['UklGR', 'image/webp'],
];

export function normalizeImageDataUrl(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return value;
  if (/^(data:|blob:|https?:\/\/)/.test(trimmed)) return trimmed;

  const signature = BASE64_SIGNATURES.find(([sig]) => trimmed.startsWith(sig));
  if (
    (trimmed.startsWith('/') ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('../')) &&
    !signature
  ) {
    return trimmed;
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed) || trimmed.length < 32) {
    return trimmed;
  }
  const mime = signature?.[1] || 'image/png';
  return `data:${mime};base64,${trimmed}`;
}

/** 上游 URL 下载用浏览器 UA（上游对直连有防盗链，先例见 reconcile-worker） */
export const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 生图数量钳制（1-10，与 ai-proxy clampImageCount 一致） */
export function clampImageCount(n) {
  const parsed = typeof n === 'number' ? n : parseInt(n, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(Math.floor(parsed), 1), 10);
}

/** 异步图像模型族（走 /v1/videos，受视频白名单门禁，MCP 首版不支持） */
const ASYNC_IMAGE_MODELS = [
  'gemini-3-pro-image-preview-async',
  'gemini-3-pro-image-preview-2k-async',
  'gemini-3-pro-image-preview-4k-async',
];

export function isAsyncImageModel(model) {
  if (!model) return false;
  const lower = String(model).toLowerCase();
  return ASYNC_IMAGE_MODELS.some((m) => lower.includes(m));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 退避重试间隔：1s / 2s / 4s / 8s（封顶） */
export function backoffDelayMs(attempt) {
  return Math.min(1000 * 2 ** Math.max(attempt, 0), 8000);
}

export function randomTaskId() {
  return randomUUID();
}

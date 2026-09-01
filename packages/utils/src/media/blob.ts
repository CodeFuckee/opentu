/**
 * Media Blob Utilities
 *
 * 判断一个 Blob 是否「像是真实的媒体文件」（图片/视频/音频），防止把非媒体响应
 * （如 dev server 对虚拟路径返回的 200 HTML 兜底页、网关错误页）误当作媒体缓存/
 * 上传/下载，导致跨设备图片显示空白。
 *
 * 校验规则（两重）：
 * 1. MIME 类型：image/* / video/* / audio/* 视为媒体；text/* / application/json
 *    等显式非媒体类型直接拒绝；
 * 2. 魔数（前 512 字节）：即使 MIME 被标为媒体，只要是 HTML 文档（<!DOCTYPE html /
 *    <html / <head / <body / <script）也拒绝——覆盖「错误页被伪装成媒体」的场景。
 *
 * 注意：合法的 SVG 图片以 <?xml 或 <svg 开头，不属于被拒绝的 HTML 特征。
 */
const HTML_DOCUMENT_MAGICS = [
  /^<!doctype html/i,
  /^<html[\s>]/i,
  /^<head[\s>]/i,
  /^<body[\s>]/i,
  /^<script[\s>]/i,
];

const NON_MEDIA_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-www-form-urlencoded',
  'multipart/',
];

/** 读取 Blob 前 512 字节（arrayBuffer 不可用时回退 FileReader，兼容 jsdom） */
async function readHeadBytes(blob: Blob): Promise<Uint8Array> {
  const head = typeof blob.slice === 'function' ? blob.slice(0, 512) : blob;
  if (typeof head.arrayBuffer === 'function') {
    try {
      return new Uint8Array(await head.arrayBuffer());
    } catch {
      // 回退 FileReader
    }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read blob failed'));
    reader.readAsArrayBuffer(head);
  });
}

/**
 * 判断 Blob 是否像是真实媒体文件（图片/视频/音频）。
 * 任何读取异常都视为「不是媒体」返回 false（保守拒绝，避免污染缓存/云端）。
 */
export async function isLikelyMediaBlob(blob: Blob | null | undefined): Promise<boolean> {
  if (!blob || blob.size === 0) {
    return false;
  }
  const type = (blob.type || '').toLowerCase();
  const isExplicitMedia =
    type.startsWith('image/') ||
    type.startsWith('video/') ||
    type.startsWith('audio/');
  if (type && !isExplicitMedia && !type.startsWith('application/octet-stream')) {
    if (NON_MEDIA_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))) {
      return false;
    }
    // 其它显式类型（application/zip 等）不武断拒绝，交给魔数校验
  }

  // 魔数校验：拒绝 HTML 文档（即使 MIME 被伪装成媒体）
  try {
    const head = await readHeadBytes(blob);
    if (head.length === 0) {
      return false;
    }
    const text = new TextDecoder().decode(head).trimStart();
    return !HTML_DOCUMENT_MAGICS.some((re) => re.test(text));
  } catch {
    return false;
  }
}
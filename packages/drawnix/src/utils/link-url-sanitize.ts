/**
 * 链接/图片 URL 消毒
 *
 * 从 MarkdownReadonly 提取的共享实现，供 Markdown 链接、知识库来源链接、
 * 任务结果链接等所有渲染为 <a href> 的不可信 URL 复用。
 */

const SCRIPT_URL_SCHEME = ['java', 'script:'].join('');
const VBSCRIPT_URL_SCHEME = ['vb', 'script:'].join('');

function startsWithSchemeIgnoringControl(url: string, scheme: string): boolean {
  let schemeIndex = 0;

  for (let i = 0; i < url.length; i += 1) {
    const code = url.charCodeAt(i);
    if (code <= 32 || code === 127) {
      continue;
    }

    if (url[i].toLowerCase() !== scheme[schemeIndex]) {
      return false;
    }

    schemeIndex += 1;
    if (schemeIndex === scheme.length) {
      return true;
    }
  }

  return false;
}

export function sanitizeLinkUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  if (
    startsWithSchemeIgnoringControl(trimmed, SCRIPT_URL_SCHEME) ||
    startsWithSchemeIgnoringControl(trimmed, VBSCRIPT_URL_SCHEME) ||
    startsWithSchemeIgnoringControl(trimmed, 'data:')
  ) {
    return null;
  }

  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(trimmed)?.[0].toLowerCase();
  if (
    scheme &&
    scheme !== 'http:' &&
    scheme !== 'https:' &&
    scheme !== 'mailto:'
  ) {
    return null;
  }

  return trimmed;
}

export function sanitizeImageUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  if (
    startsWithSchemeIgnoringControl(trimmed, SCRIPT_URL_SCHEME) ||
    startsWithSchemeIgnoringControl(trimmed, VBSCRIPT_URL_SCHEME)
  ) {
    return null;
  }

  if (startsWithSchemeIgnoringControl(trimmed, 'data:')) {
    return /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(trimmed)
      ? trimmed
      : null;
  }

  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(trimmed)?.[0].toLowerCase();
  if (
    scheme &&
    scheme !== 'http:' &&
    scheme !== 'https:' &&
    scheme !== 'blob:' &&
    scheme !== 'asset:'
  ) {
    return null;
  }

  return trimmed;
}

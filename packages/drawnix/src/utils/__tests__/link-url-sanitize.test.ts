import { describe, expect, it } from 'vitest';
import { sanitizeImageUrl, sanitizeLinkUrl } from '../link-url-sanitize';

describe('sanitizeLinkUrl', () => {
  it('allows http/https/mailto and scheme-less urls', () => {
    expect(sanitizeLinkUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(sanitizeLinkUrl('http://example.com')).toBe('http://example.com');
    expect(sanitizeLinkUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(sanitizeLinkUrl('/relative/path')).toBe('/relative/path');
    expect(sanitizeLinkUrl('//cdn.example.com/x.png')).toBe('//cdn.example.com/x.png');
  });

  it('rejects javascript:/vbscript:/data: urls', () => {
    expect(sanitizeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeLinkUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(sanitizeLinkUrl('vbscript:msgbox(1)')).toBeNull();
    expect(sanitizeLinkUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects control-char obfuscated javascript: urls', () => {
    expect(sanitizeLinkUrl('java\tscript:alert(1)')).toBeNull();
    expect(sanitizeLinkUrl('java\nscript:alert(1)')).toBeNull();
  });

  it('rejects other dangerous schemes', () => {
    expect(sanitizeLinkUrl('file:///etc/passwd')).toBeNull();
    expect(sanitizeLinkUrl('blob:https://example.com/x')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(sanitizeLinkUrl('')).toBeNull();
    expect(sanitizeLinkUrl('   ')).toBeNull();
  });
});

describe('sanitizeImageUrl', () => {
  it('allows http/https/blob/asset and image data urls', () => {
    expect(sanitizeImageUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(sanitizeImageUrl('blob:https://example.com/x')).toBe('blob:https://example.com/x');
    expect(sanitizeImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('rejects non-image data urls', () => {
    expect(sanitizeImageUrl('data:text/html,<b>x</b>')).toBeNull();
  });

  it('rejects javascript: urls', () => {
    expect(sanitizeImageUrl('javascript:alert(1)')).toBeNull();
  });
});

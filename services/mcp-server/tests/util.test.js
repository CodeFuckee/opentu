import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASPECT_RATIO_TO_SIZE,
  clampImageCount,
  emailPrefix,
  isAsyncImageModel,
  mimeToExtension,
  normalizeImageDataUrl,
  normalizeImageSize,
  sanitizeUsername,
  sha256Hex,
  sniffImageMime,
  todayDateString,
} from '../src/util.js';

test('normalizeImageSize：比例别名映射与前端同表', () => {
  assert.equal(normalizeImageSize('1x1'), ASPECT_RATIO_TO_SIZE['1x1']);
  assert.equal(normalizeImageSize('16x9'), '1792x1024');
  assert.equal(normalizeImageSize('9x16'), '1024x1792');
  assert.equal(normalizeImageSize('16:9'), '1792x1024');
  assert.equal(normalizeImageSize('1:1'), '1024x1024');
});

test('normalizeImageSize：像素串放行 / auto 与非法值回退默认', () => {
  assert.equal(normalizeImageSize('1536x1152'), '1536x1152');
  assert.equal(normalizeImageSize('auto'), '1024x1024');
  assert.equal(normalizeImageSize(''), '1024x1024');
  assert.equal(normalizeImageSize(undefined, '512x512'), '512x512');
  assert.equal(normalizeImageSize('not-a-size'), '1024x1024');
});

test('sanitizeUsername：与前端同规则（trim/小写/非法字符换 _/截断 64）', () => {
  assert.equal(sanitizeUsername('  Chen.Kaidi-01 '), 'chen.kaidi-01');
  assert.equal(sanitizeUsername('a+b@c'), 'a_b_c');
  assert.equal(sanitizeUsername('中文用户'), '____');
  assert.equal(sanitizeUsername('x'.repeat(100)), 'x'.repeat(64));
  assert.equal(sanitizeUsername(''), '');
  assert.equal(sanitizeUsername(undefined), '');
});

test('emailPrefix：取 @ 前段', () => {
  assert.equal(emailPrefix('chen@example.com'), 'chen');
  assert.equal(emailPrefix('no-at'), 'no-at');
  assert.equal(emailPrefix(''), '');
});

test('sniffImageMime：严格模式，未知字节返回空串', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
  assert.equal(sniffImageMime(png), 'image/png');

  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(16),
  ]);
  assert.equal(sniffImageMime(jpeg), 'image/jpeg');

  const gif = Buffer.concat([
    Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    Buffer.alloc(16),
  ]);
  assert.equal(sniffImageMime(gif), 'image/gif');

  const webp = Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
    Buffer.alloc(16),
  ]);
  assert.equal(sniffImageMime(webp), 'image/webp');

  const html = Buffer.from('<html><body>error</body></html>');
  assert.equal(sniffImageMime(html), '');
  assert.equal(sniffImageMime(Buffer.alloc(0)), '');
  assert.equal(sniffImageMime(null), '');
});

test('mimeToExtension：jpeg → jpg', () => {
  assert.equal(mimeToExtension('image/png'), 'png');
  assert.equal(mimeToExtension('image/jpeg'), 'jpg');
  assert.equal(mimeToExtension('image/webp'), 'webp');
  assert.equal(mimeToExtension('image/gif'), 'gif');
  assert.equal(mimeToExtension(''), 'png');
});

test('normalizeImageDataUrl：裸 base64 转 data URL，URL/data/相对路径原样', () => {
  assert.equal(
    normalizeImageDataUrl('https://up.example/a.png'),
    'https://up.example/a.png'
  );
  assert.equal(
    normalizeImageDataUrl('data:image/png;base64,AAA'),
    'data:image/png;base64,AAA'
  );
  // /9j/ 开头命中 JPEG 签名 → 转 data URL
  const jpegB64 = '/9j/' + 'A'.repeat(64);
  assert.equal(
    normalizeImageDataUrl(jpegB64),
    `data:image/jpeg;base64,${jpegB64}`
  );
  // iVBOR 开头命中 PNG 签名
  const pngB64 = 'iVBOR' + 'A'.repeat(64);
  assert.equal(
    normalizeImageDataUrl(pngB64),
    `data:image/png;base64,${pngB64}`
  );
  // 相对路径原样返回（不以 base64 签名开头）
  assert.equal(normalizeImageDataUrl('/assets/img.png'), '/assets/img.png');
  // 短于 32 字符不转换（前端同守卫，防误判）
  assert.equal(normalizeImageDataUrl('iVBORw0KGgo'), 'iVBORw0KGgo');
  // 含非 base64 字符不转换（首尾空白会被 trim 后返回，与前端一致）
  assert.equal(
    normalizeImageDataUrl('<html>error page</html>'.padEnd(40, ' ')),
    '<html>error page</html>'
  );
  assert.equal(normalizeImageDataUrl(''), '');
});

test('clampImageCount：钳制 1-10，非法回 1', () => {
  assert.equal(clampImageCount(1), 1);
  assert.equal(clampImageCount(5), 5);
  assert.equal(clampImageCount(99), 10);
  assert.equal(clampImageCount(0), 1);
  assert.equal(clampImageCount(-3), 1);
  assert.equal(clampImageCount('4'), 4);
  assert.equal(clampImageCount(undefined), 1);
  assert.equal(clampImageCount(2.9), 2);
});

test('isAsyncImageModel：命中 gemini 异步图像族', () => {
  assert.equal(isAsyncImageModel('gemini-3-pro-image-preview-2k-async'), true);
  assert.equal(isAsyncImageModel('Gemini-3-Pro-Image-Preview-Async'), true);
  assert.equal(isAsyncImageModel('gpt-image-2'), false);
  assert.equal(isAsyncImageModel(''), false);
  assert.equal(isAsyncImageModel(undefined), false);
});

test('todayDateString：YYYY-MM-DD 本地日期', () => {
  assert.equal(todayDateString(new Date(2026, 10, 5)), '2026-11-05');
  assert.equal(todayDateString(new Date(2026, 0, 9)), '2026-01-09');
});

test('sha256Hex：确定性摘要', () => {
  assert.equal(
    sha256Hex(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

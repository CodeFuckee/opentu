/**
 * task-supabase-archive 核心纯函数单测
 *
 * 覆盖：
 * - isDataUrl / parseDataUrl / dataUrlToBlob（base64 与 raw 两种编码）
 * - mimeToExtension 扩展名映射（含未知 MIME 回退）
 * - getLocalDateString 本地日期 YYYY-MM-DD
 * - sanitizeUsername 用户名清洗（目录安全）
 * - buildStoragePath 路径拼接
 * - sha256Hex / hashBlob SHA-256 哈希
 * - buildFileEntries 提取文件条目（去重、哈希、路径）
 * - toParamsWithFilePaths 参数中 dataURL 替换为存储路径（深拷贝、不污染原对象）
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  isDataUrl,
  parseDataUrl,
  dataUrlToBlob,
  mimeToExtension,
  getLocalDateString,
  sanitizeUsername,
  buildStoragePath,
  sha256Hex,
  hashBlob,
  buildFileEntries,
  toParamsWithFilePaths,
} from './core';

// jsdom 环境不提供 crypto.subtle，测试内用 Node webcrypto 补齐
beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const BASE64_OF_ABC = 'YWJj'; // 'abc'

// jsdom 的 Blob 不实现 text()/arrayBuffer()，用 FileReader 读取文本做断言
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('isDataUrl', () => {
  it('data: 前缀字符串返回 true', () => {
    expect(isDataUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isDataUrl('data:image/svg+xml,<svg/>')).toBe(true);
  });

  it('非 data URL 返回 false', () => {
    expect(isDataUrl('http://example.com/a.png')).toBe(false);
    expect(isDataUrl('/__aitu_cache__/abc')).toBe(false);
    expect(isDataUrl('')).toBe(false);
    expect(isDataUrl(123)).toBe(false);
    expect(isDataUrl(null)).toBe(false);
  });
});

describe('parseDataUrl', () => {
  it('解析 base64 data URL 的 mime 与数据', () => {
    const parsed = parseDataUrl(`data:image/png;base64,${BASE64_OF_ABC}`);
    expect(parsed.mimeType).toBe('image/png');
    expect(parsed.isBase64).toBe(true);
    expect(parsed.data).toBe(BASE64_OF_ABC);
  });

  it('解析 raw data URL（如 svg）', () => {
    const parsed = parseDataUrl('data:image/svg+xml,%3Csvg%3E');
    expect(parsed.mimeType).toBe('image/svg+xml');
    expect(parsed.isBase64).toBe(false);
  });

  it('mime 缺失时回退 octet-stream', () => {
    const parsed = parseDataUrl(`data:;base64,${BASE64_OF_ABC}`);
    expect(parsed.mimeType).toBe('application/octet-stream');
  });

  it('非法输入抛错', () => {
    expect(() => parseDataUrl('not-a-data-url')).toThrow();
    expect(() => parseDataUrl('')).toThrow();
  });
});

describe('dataUrlToBlob', () => {
  it('base64 解码为正确内容与 mime', async () => {
    const blob = dataUrlToBlob(`data:image/png;base64,${BASE64_OF_ABC}`);
    expect(blob.type).toBe('image/png');
    const text = await readBlobText(blob);
    expect(text).toBe('abc');
  });

  it('raw 编码解码为 utf-8 文本', async () => {
    const blob = dataUrlToBlob('data:image/svg+xml,%3Csvg%3E');
    expect(blob.type).toBe('image/svg+xml');
    const text = await readBlobText(blob);
    expect(text).toBe('<svg>');
  });
});

describe('mimeToExtension', () => {
  it('常见 MIME 映射到扩展名', () => {
    expect(mimeToExtension('image/png')).toBe('png');
    expect(mimeToExtension('image/jpeg')).toBe('jpg');
    expect(mimeToExtension('image/webp')).toBe('webp');
    expect(mimeToExtension('image/gif')).toBe('gif');
    expect(mimeToExtension('image/svg+xml')).toBe('svg');
    expect(mimeToExtension('video/mp4')).toBe('mp4');
    expect(mimeToExtension('video/webm')).toBe('webm');
    expect(mimeToExtension('audio/mpeg')).toBe('mp3');
    expect(mimeToExtension('audio/wav')).toBe('wav');
    expect(mimeToExtension('application/pdf')).toBe('pdf');
  });

  it('未知 MIME 回退 bin', () => {
    expect(mimeToExtension('application/x-weird')).toBe('bin');
    expect(mimeToExtension('')).toBe('bin');
  });
});

describe('getLocalDateString', () => {
  it('返回本地时区 YYYY-MM-DD', () => {
    const date = new Date(2025, 0, 2, 12, 0, 0); // 2025-01-02 本地时间
    expect(getLocalDateString(date)).toBe('2025-01-02');
  });

  it('月份与日期补零', () => {
    const date = new Date(2025, 10, 5); // 2025-11-05
    expect(getLocalDateString(date)).toBe('2025-11-05');
  });

  it('缺省使用当前时间（格式正确）', () => {
    const result = getLocalDateString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('sanitizeUsername', () => {
  it('转小写', () => {
    expect(sanitizeUsername('ZhangSan')).toBe('zhangsan');
  });

  it('非法字符替换为下划线', () => {
    expect(sanitizeUsername('zhang san!')).toBe('zhang_san_');
  });

  it('允许点与中划线', () => {
    expect(sanitizeUsername('zhang.san-ls')).toBe('zhang.san-ls');
  });

  it('空串返回空串', () => {
    expect(sanitizeUsername('')).toBe('');
  });

  it('超长截断', () => {
    expect(sanitizeUsername('a'.repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

describe('buildStoragePath', () => {
  it('拼接 用户名/日期/input-哈希.扩展名', () => {
    expect(buildStoragePath('zhangsan', '2025-01-02', 'abc123', 'png')).toBe(
      'zhangsan/2025-01-02/input-abc123.png'
    );
  });

  it('空用户名时只保留日期路径', () => {
    expect(buildStoragePath('', '2025-01-02', 'abc', 'png')).toBe(
      '2025-01-02/input-abc.png'
    );
  });
});

describe('sha256Hex / hashBlob', () => {
  it('sha256Hex 对 abc 输出已知摘要', async () => {
    const digest = await sha256Hex(new TextEncoder().encode('abc'));
    expect(digest).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('sha256Hex 对空输入输出空串摘要', async () => {
    const digest = await sha256Hex(new Uint8Array(0));
    expect(digest).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('hashBlob 对 Blob 内容哈希', async () => {
    const digest = await hashBlob(new Blob(['abc'], { type: 'text/plain' }));
    expect(digest).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('不同内容产生不同哈希', async () => {
    const a = await hashBlob(new Blob(['abc']));
    const b = await hashBlob(new Blob(['abd']));
    expect(a).not.toBe(b);
  });
});

describe('buildFileEntries', () => {
  it('提取 dataURL 并生成哈希与存储路径', async () => {
    const params = {
      prompt: 'a cat',
      uploadedImages: [
        { url: `data:image/png;base64,${BASE64_OF_ABC}`, name: 'cat.png' },
      ],
    };
    const { entries, pathByDataUrl } = await buildFileEntries(
      params,
      'zhangsan',
      '2025-01-02'
    );

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.mimeType).toBe('image/png');
    expect(entry.extension).toBe('png');
    expect(entry.storagePath).toMatch(/^zhangsan\/2025-01-02\/input-[0-9a-f]{64}\.png$/);
    expect(pathByDataUrl.get(`data:image/png;base64,${BASE64_OF_ABC}`)).toBe(
      entry.storagePath
    );
  });

  it('相同 dataURL 多次出现只上传一次（去重）', async () => {
    const params = {
      uploadedImages: [
        { url: `data:image/png;base64,${BASE64_OF_ABC}` },
        { url: `data:image/png;base64,${BASE64_OF_ABC}` },
      ],
      referenceImages: [`data:image/png;base64,${BASE64_OF_ABC}`],
    };
    const { entries, pathByDataUrl } = await buildFileEntries(
      params,
      'zhangsan',
      '2025-01-02'
    );
    expect(entries).toHaveLength(1);
    expect(pathByDataUrl.size).toBe(1);
  });

  it('http/blob URL 与普通字段不提取', async () => {
    const params = {
      prompt: 'hello',
      referenceImages: ['https://example.com/a.png', '/__aitu_cache__/b.png'],
      model: 'flux',
    };
    const { entries } = await buildFileEntries(params, 'zhangsan', '2025-01-02');
    expect(entries).toHaveLength(0);
  });

  it('深层嵌套字段也能提取', async () => {
    const params = {
      outer: {
        inner: [{ img: `data:image/jpeg;base64,${BASE64_OF_ABC}` }],
      },
      videoData: `data:video/mp4;base64,${BASE64_OF_ABC}`,
    };
    const { entries } = await buildFileEntries(params, 'zhangsan', '2025-01-02');
    expect(entries).toHaveLength(2);
    const exts = entries.map((e) => e.extension).sort();
    expect(exts).toEqual(['jpg', 'mp4']);
  });
});

describe('toParamsWithFilePaths', () => {
  it('把 dataURL 替换为存储路径，其余字段保留', () => {
    const dataUrl = `data:image/png;base64,${BASE64_OF_ABC}`;
    const params = {
      prompt: 'a cat',
      uploadedImages: [{ url: dataUrl, name: 'cat.png' }],
      referenceImages: [dataUrl, 'https://example.com/x.png'],
      size: '1:1',
    };
    const pathByDataUrl = new Map([[dataUrl, 'zhangsan/2025-01-02/input-h.png']]);
    const next = toParamsWithFilePaths(params, pathByDataUrl);

    expect(next.uploadedImages?.[0]?.url).toBe(
      'zhangsan/2025-01-02/input-h.png'
    );
    expect(next.referenceImages?.[0]).toBe('zhangsan/2025-01-02/input-h.png');
    expect(next.referenceImages?.[1]).toBe('https://example.com/x.png');
    expect(next.prompt).toBe('a cat');
    expect(next.size).toBe('1:1');
  });

  it('不修改原对象（深拷贝）', () => {
    const dataUrl = `data:image/png;base64,${BASE64_OF_ABC}`;
    const params = { uploadedImages: [{ url: dataUrl }] };
    const pathByDataUrl = new Map([[dataUrl, 'zhangsan/x.png']]);
    const next = toParamsWithFilePaths(params, pathByDataUrl);

    expect(params.uploadedImages?.[0]?.url).toBe(dataUrl);
    expect(next).not.toBe(params);
    expect(next.uploadedImages?.[0]).not.toBe(params.uploadedImages?.[0]);
  });
});

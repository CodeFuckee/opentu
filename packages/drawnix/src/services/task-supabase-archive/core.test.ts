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
  collectBase64Values,
  collectVirtualMediaUrls,
  extractBase64Payload,
  extractMimeFromDataUrl,
  sniffMimeFromBytes,
  decodeResponseBase64,
  buildOutputStoragePath,
  replaceBase64WithPaths,
  replaceStringsWithPaths,
  isTerminalResponseState,
  hasOpenAIImageMedia,
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

describe('collectBase64Values（响应归档 b64 值收集）', () => {
  it('收集 b64_json / b64 / base64 字段值（大小写不敏感）与 dataURL', () => {
    const json = {
      created: 1,
      data: [
        { b64_json: 'AAA', revised_prompt: 'x' },
        { B64_JSON: 'BBB' },
        { inner: { b64: 'CCC' } },
        { vec: ['DDD', 'EEE'] },
      ],
      extra: { base64: 'FFF' },
      url: 'https://example.com/a.png',
      dataUrl: 'data:image/png;base64,GGG',
    };
    const values = collectBase64Values(json);
    expect(values).toEqual([
      'AAA',
      'BBB',
      'CCC',
      'FFF',
      'data:image/png;base64,GGG',
    ]);
  });

  it('去除重复值（保持首次出现顺序）', () => {
    const json = { data: [{ b64_json: 'AAA' }, { b64_json: 'AAA' }] };
    expect(collectBase64Values(json)).toEqual(['AAA']);
  });

  it('无 base64 值时返回空数组', () => {
    expect(collectBase64Values({ data: [{ url: 'https://x/a.png' }] })).toEqual(
      []
    );
    expect(collectBase64Values(null)).toEqual([]);
    expect(collectBase64Values('plain')).toEqual([]);
  });
});

describe('extractBase64Payload / extractMimeFromDataUrl', () => {
  it('普通字符串（b64_json 值）原样返回', () => {
    expect(extractBase64Payload('YWJj')).toBe('YWJj');
  });

  it('dataURL 剥离 data 头返回 base64 载荷', () => {
    expect(extractBase64Payload('data:image/png;base64,YWJj')).toBe('YWJj');
  });

  it('非 base64 编码的 dataURL 返回 null（跳过）', () => {
    expect(extractBase64Payload('data:image/svg+xml,<svg/>')).toBeNull();
  });

  it('提取 dataURL 的 MIME', () => {
    expect(extractMimeFromDataUrl('data:image/jpeg;base64,AAA')).toBe(
      'image/jpeg'
    );
    expect(extractMimeFromDataUrl('data:image/png;base64,AAA')).toBe(
      'image/png'
    );
    expect(extractMimeFromDataUrl('not-a-data-url')).toBeNull();
  });
});

describe('sniffMimeFromBytes / decodeResponseBase64', () => {
  it('PNG 魔数识别为 image/png', () => {
    // 1x1 透明 PNG
    const bytes = decodeResponseBase64(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    );
    expect(sniffMimeFromBytes(bytes)).toBe('image/png');
  });

  it('JPEG 魔数识别为 image/jpeg', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniffMimeFromBytes(bytes)).toBe('image/jpeg');
  });

  it('未知二进制回退 image/png', () => {
    expect(sniffMimeFromBytes(new Uint8Array([1, 2, 3]))).toBe('image/png');
  });

  it('decodeResponseBase64 解码正确', () => {
    const bytes = decodeResponseBase64('YWJj');
    expect(Array.from(bytes)).toEqual([97, 98, 99]);
  });
});

describe('buildOutputStoragePath', () => {
  it('拼接 用户名/日期/output-哈希.扩展名', () => {
    expect(buildOutputStoragePath('zhangsan', '2025-01-02', 'abc123', 'png')).toBe(
      'zhangsan/2025-01-02/output-abc123.png'
    );
  });

  it('空用户名时只保留日期路径', () => {
    expect(buildOutputStoragePath('', '2025-01-02', 'abc', 'jpg')).toBe(
      '2025-01-02/output-abc.jpg'
    );
  });
});

describe('replaceBase64WithPaths', () => {
  it('把命中的 base64 值替换为存储路径，其余保留', () => {
    const pathByValue = new Map([
      ['AAA', 'zhangsan/2025-01-02/output-a.png'],
      ['data:image/png;base64,BBB', 'zhangsan/2025-01-02/output-b.png'],
    ]);
    const json = {
      data: [{ b64_json: 'AAA', revised_prompt: 'x' }],
      extra: 'data:image/png;base64,BBB',
      url: 'https://x/a.png',
    };
    const next = replaceBase64WithPaths(json, pathByValue) as any;
    expect(next.data[0].b64_json).toBe('zhangsan/2025-01-02/output-a.png');
    expect(next.extra).toBe('zhangsan/2025-01-02/output-b.png');
    expect(next.url).toBe('https://x/a.png');
  });

  it('不修改原对象（深拷贝）', () => {
    const json = { data: [{ b64_json: 'AAA' }] };
    const pathByValue = new Map([['AAA', 'zhangsan/x.png']]);
    const next = replaceBase64WithPaths(json, pathByValue) as any;
    expect(json.data[0].b64_json).toBe('AAA');
    expect(next).not.toBe(json);
    expect(next.data[0]).not.toBe(json.data[0]);
  });
});

describe('isTerminalResponseState', () => {
  it('终态成功/失败返回 true（含 data 层）', () => {
    expect(isTerminalResponseState({ status: 'completed' })).toBe(true);
    expect(isTerminalResponseState({ status: 'success' })).toBe(true);
    expect(isTerminalResponseState({ status: 'failed' })).toBe(true);
    expect(isTerminalResponseState({ status: 'cancelled' })).toBe(true);
    expect(isTerminalResponseState({ data: { task_status: 'completed' } })).toBe(
      true
    );
  });

  it('中间态 / 空 / 非对象返回 false', () => {
    expect(isTerminalResponseState({ status: 'processing' })).toBe(false);
    expect(isTerminalResponseState({ status: 'queued' })).toBe(false);
    expect(isTerminalResponseState({ progress: 40 })).toBe(false);
    expect(isTerminalResponseState(null)).toBe(false);
    expect(isTerminalResponseState('whatever')).toBe(false);
  });
});

describe('collectVirtualMediaUrls（输入归档虚拟媒体路径收集）', () => {
  it('收集 /asset-library/ 与 /__aitu_cache__/ 路径（去重）', () => {
    const seen = new Set<string>();
    collectVirtualMediaUrls(
      {
        prompt: 'plain',
        uploadedImages: [
          { url: '/asset-library/content-abc.png' },
          { url: '/asset-library/content-abc.png' },
        ],
        referenceImages: ['/__aitu_cache__/image/content-def.png'],
        nested: { list: ['/asset-library/content-ghi.png'] },
      },
      seen
    );
    expect(Array.from(seen).sort()).toEqual([
      '/__aitu_cache__/image/content-def.png',
      '/asset-library/content-abc.png',
      '/asset-library/content-ghi.png',
    ]);
  });

  it('data URL 与 http URL 不收集', () => {
    const seen = new Set<string>();
    collectVirtualMediaUrls(
      {
        uploadedImages: [{ url: 'data:image/png;base64,YWJj' }],
        referenceImages: ['https://example.com/x.png'],
      },
      seen
    );
    expect(seen.size).toBe(0);
  });
});

describe('replaceStringsWithPaths（通用字符串替换，输入归档用）', () => {
  it('替换任意出现在映射中的字符串（含虚拟 URL，顶层字符串也替换）', () => {
    const params = {
      uploadedImages: [{ url: '/asset-library/content-abc.png' }],
      prompt: 'a cat',
    };
    const pathByValue = new Map([
      ['/asset-library/content-abc.png', 'chenkaidi/2026-08-30/input-h.png'],
    ]);
    const next = replaceStringsWithPaths(params, pathByValue) as any;
    expect(next.uploadedImages[0].url).toBe(
      'chenkaidi/2026-08-30/input-h.png'
    );
    expect(next.prompt).toBe('a cat');
    // 顶层字符串替换
    expect(
      replaceStringsWithPaths('/asset-library/content-abc.png', pathByValue)
    ).toBe('chenkaidi/2026-08-30/input-h.png');
  });

  it('不修改原对象（深拷贝）', () => {
    const params = { uploadedImages: [{ url: '/asset-library/abc.png' }] };
    const pathByValue = new Map([['/asset-library/abc.png', 'chenkaidi/x.png']]);
    const next = replaceStringsWithPaths(params, pathByValue);
    expect((params.uploadedImages as any)[0].url).toBe('/asset-library/abc.png');
    expect(next).not.toBe(params);
  });
});

describe('hasOpenAIImageMedia（OpenAI 图片响应形状判定）', () => {
  it('data[] 含 url 或 b64_json 的响应判定为已产生媒体', () => {
    expect(hasOpenAIImageMedia({ created: 1, data: [{ url: 'https://x/a.png' }] })).toBe(true);
    expect(hasOpenAIImageMedia({ data: [{ b64_json: 'AAA' }] })).toBe(true);
    expect(hasOpenAIImageMedia({ data: [{ url: 'https://x/a.png' }, { url: 'https://x/b.png' }] })).toBe(true);
  });

  it('中间态 / 非图片 / 空返回 false', () => {
    expect(hasOpenAIImageMedia({ status: 'processing', progress: 40 })).toBe(false);
    expect(hasOpenAIImageMedia({ data: [{ url: 123 }] })).toBe(false);
    expect(hasOpenAIImageMedia({ data: [] })).toBe(false);
    expect(hasOpenAIImageMedia({ data: 'plain' })).toBe(false);
    expect(hasOpenAIImageMedia(null)).toBe(false);
    expect(hasOpenAIImageMedia({ status: 'completed', url: 'https://x/a.png' })).toBe(false);
  });
});

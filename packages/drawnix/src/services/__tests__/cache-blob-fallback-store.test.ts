/**
 * cache-blob-fallback-store 单元测试
 *
 * 该模块是 Cache Storage API 缺失（非安全上下文，如纯 HTTP 内网部署）时的
 * IndexedDB 兜底 Blob 存储。vitest.setup.ts 已全局安装 fake-indexeddb，
 * 测试直接在真实（fake）IndexedDB 上验证写入/读取/删除/清空/列表。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCacheBlobFallbacks,
  deleteCacheBlobFallback,
  getCacheBlobFallback,
  listCacheBlobFallbackUrls,
  putCacheBlobFallback,
} from '../cache-blob-fallback-store';

const URL_1 = '/asset-library/content-fnv8c77534cc1d99761de15b5.png';
const URL_2 = '/__aitu_cache__/image/content-abc.png';

function makeBlob(content: string, type = 'image/png'): Blob {
  return new Blob([content], { type });
}

describe('cache-blob-fallback-store', () => {
  beforeEach(async () => {
    await clearCacheBlobFallbacks();
  });

  afterEach(async () => {
    await clearCacheBlobFallbacks();
  });

  it('put → get 返回相同的真实媒体 Blob', async () => {
    const blob = makeBlob('fake-png-bytes-1');

    await expect(putCacheBlobFallback(URL_1, blob)).resolves.toBe(true);

    const read = await getCacheBlobFallback(URL_1);
    expect(read).not.toBeNull();
    expect(read!.type).toBe('image/png');
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(read!);
    });
    expect(text).toBe('fake-png-bytes-1');
  });

  it('未写入的 url 返回 null，空 url/空 blob 不写入', async () => {
    expect(await getCacheBlobFallback(URL_2)).toBeNull();
    await expect(putCacheBlobFallback('', makeBlob('x'))).resolves.toBe(false);
    await expect(putCacheBlobFallback(URL_2, null as unknown as Blob)).resolves.toBe(false);
    expect(await getCacheBlobFallback(URL_2)).toBeNull();
  });

  it('delete 后读取返回 null', async () => {
    await putCacheBlobFallback(URL_1, makeBlob('to-delete'));
    await putCacheBlobFallback(URL_2, makeBlob('keep'));

    await deleteCacheBlobFallback(URL_1);

    expect(await getCacheBlobFallback(URL_1)).toBeNull();
    expect(await getCacheBlobFallback(URL_2)).not.toBeNull();
  });

  it('list 返回全部已写入 url', async () => {
    await putCacheBlobFallback(URL_1, makeBlob('a'));
    await putCacheBlobFallback(URL_2, makeBlob('b'));

    const urls = await listCacheBlobFallbackUrls();
    expect(new Set(urls)).toEqual(new Set([URL_1, URL_2]));
  });

  it('clear 清空全部记录', async () => {
    await putCacheBlobFallback(URL_1, makeBlob('a'));
    await putCacheBlobFallback(URL_2, makeBlob('b'));

    await clearCacheBlobFallbacks();

    expect(await listCacheBlobFallbackUrls()).toEqual([]);
    expect(await getCacheBlobFallback(URL_1)).toBeNull();
    expect(await getCacheBlobFallback(URL_2)).toBeNull();
  });
});

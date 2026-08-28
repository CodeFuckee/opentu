/**
 * ai-proxy 响应归档纯函数单测（node:test）
 *
 * 覆盖：
 * - 白名单 base64 字段（b64_json / b64 / base64）与 dataURL 值识别
 * - base64 解码 / MIME 嗅探 / 扩展名推导 / output 存储路径拼接
 * - 深拷贝替换（base64 值 → 存储路径），不污染原对象
 * - 异步任务终态判定（成功/失败为终态，中间态不是）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE64_KEYS,
  isDataUrlValue,
  collectBase64Values,
  decodeBase64ToBytes,
  extractBase64Payload,
  sniffMimeFromBytes,
  mimeToExtension,
  buildOutputStoragePath,
  replaceBase64WithPaths,
  isTerminalAsyncState,
  extractMimeFromDataUrl,
} from './archive.ts';

/** 1x1 透明 PNG（可被 magic bytes 识别） */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('BASE64_KEYS 白名单包含 b64_json / b64 / base64', () => {
  assert.equal(BASE64_KEYS.has('b64_json'), true);
  assert.equal(BASE64_KEYS.has('b64'), true);
  assert.equal(BASE64_KEYS.has('base64'), true);
});

test('isDataUrlValue：data: 前缀为真，其余为假', () => {
  assert.equal(isDataUrlValue('data:image/png;base64,AAAA'), true);
  assert.equal(isDataUrlValue('data:image/png,raw'), true);
  assert.equal(isDataUrlValue('http://a/b.png'), false);
  assert.equal(isDataUrlValue('AAAA'), false);
  assert.equal(isDataUrlValue(null), false);
  assert.equal(isDataUrlValue(123), false);
});

test('collectBase64Values：白名单字段与 dataURL 值深度收集、去重保序', () => {
  // b64_json 数组元素
  assert.deepEqual(
    collectBase64Values({ data: [{ b64_json: TINY_PNG_B64 }] }),
    [TINY_PNG_B64]
  );
  // 非白名单 key 不收集（即便值像 base64 长串）
  assert.deepEqual(
    collectBase64Values({ data: [{ image: TINY_PNG_B64 }] }),
    []
  );
  // url 字段不改动
  assert.deepEqual(collectBase64Values({ data: [{ url: 'http://x.png' }] }), []);
  // 深浅嵌套 + 去重 + 保序
  const payload = {
    thumb: { b64: 'BBBB' },
    extra: [{ base64: 'BBBB' }, [{ b64_json: 'CCCC' }]],
    blob: 'data:image/png;base64,DDDD',
  };
  assert.deepEqual(collectBase64Values(payload), ['BBBB', 'CCCC', 'data:image/png;base64,DDDD']);
  // 非字符串值忽略
  assert.deepEqual(collectBase64Values({ data: [{ b64_json: 42 }], b64: null }), []);
  // 空对象 / null
  assert.deepEqual(collectBase64Values(null), []);
  assert.deepEqual(collectBase64Values({}), []);
});

test('decodeBase64ToBytes：base64 解码为字节', () => {
  assert.deepEqual(Array.from(decodeBase64ToBytes('AQID')), [1, 2, 3]);
  assert.ok(decodeBase64ToBytes(TINY_PNG_B64).length > 0);
});

test('extractBase64Payload：dataURL 剥离头部，非 base64 dataURL 返回 null', () => {
  assert.equal(extractBase64Payload(`data:image/png;base64,${TINY_PNG_B64}`), TINY_PNG_B64);
  assert.equal(extractBase64Payload('data:image/png,rawdata'), null);
  assert.equal(extractBase64Payload(TINY_PNG_B64), TINY_PNG_B64);
});

test('sniffMimeFromBytes：常见图片魔数识别，未知回退 image/png', () => {
  const png = decodeBase64ToBytes(TINY_PNG_B64);
  assert.equal(sniffMimeFromBytes(png), 'image/png');
  assert.equal(sniffMimeFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  const gif = new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0)));
  assert.equal(sniffMimeFromBytes(gif), 'image/gif');
  const webp = new Uint8Array([
    ...'RIFF'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0,
    ...'WEBP'.split('').map((c) => c.charCodeAt(0)),
  ]);
  assert.equal(sniffMimeFromBytes(webp), 'image/webp');
  const avif = new Uint8Array([
    0, 0, 0, 0, ...'ftyp'.split('').map((c) => c.charCodeAt(0)),
    ...'avif'.split('').map((c) => c.charCodeAt(0)),
  ]);
  assert.equal(sniffMimeFromBytes(avif), 'image/avif');
  assert.equal(sniffMimeFromBytes(new Uint8Array([1, 2, 3, 4, 5])), 'image/png');
});

test('mimeToExtension：常见类型映射，未知回退 bin', () => {
  assert.equal(mimeToExtension('image/png'), 'png');
  assert.equal(mimeToExtension('image/jpeg'), 'jpg');
  assert.equal(mimeToExtension('image/webp'), 'webp');
  assert.equal(mimeToExtension('image/gif'), 'gif');
  assert.equal(mimeToExtension('image/avif'), 'avif');
  assert.equal(mimeToExtension('application/octet-stream'), 'bin');
});

test('extractMimeFromDataUrl：提取 dataURL 的 MIME', () => {
  assert.equal(extractMimeFromDataUrl('data:image/png;base64,AAAA'), 'image/png');
  assert.equal(extractMimeFromDataUrl('data:image/jpeg;base64,AAAA'), 'image/jpeg');
  assert.equal(extractMimeFromDataUrl('data:;base64,AAAA'), null);
  assert.equal(extractMimeFromDataUrl(TINY_PNG_B64), null);
});

test('buildOutputStoragePath：{user}/{date}/output-{hash}.{ext}', () => {
  assert.equal(buildOutputStoragePath('zhangsan', '2026-08-28', 'abc123', 'png'), 'zhangsan/2026-08-28/output-abc123.png');
  assert.equal(buildOutputStoragePath('', '2026-08-28', 'abc123', 'png'), '2026-08-28/output-abc123.png');
});

test('replaceBase64WithPaths：深拷贝替换，未替换值保留、原对象不污染', () => {
  const path = 'zhangsan/2026-08-28/output-abc.png';
  const value = { data: [{ b64_json: TINY_PNG_B64, url: 'http://x' }], meta: { extra: [TINY_PNG_B64] } };
  const map = new Map([[TINY_PNG_B64, path]]);
  const replaced = replaceBase64WithPaths(value, map);
  assert.equal(replaced.data[0].b64_json, path);
  assert.equal(replaced.data[0].url, 'http://x');
  assert.equal(replaced.meta.extra[0], path);
  // 原对象未被修改
  assert.equal(value.data[0].b64_json, TINY_PNG_B64);
  assert.notEqual(replaced, value, '应为深拷贝返回新对象');
  // 不在映射中的值原样保留
  assert.equal(replaceBase64WithPaths({ a: 'not-in-map' }, map).a, 'not-in-map');
  // 非对象输入原样返回
  assert.equal(replaceBase64WithPaths('x', map), 'x');
  assert.equal(replaceBase64WithPaths(null, map), null);
  // 数组顶层处理
  assert.deepEqual(replaceBase64WithPaths([{ b64_json: TINY_PNG_B64 }], map), [{ b64_json: path }]);
});

test('isTerminalAsyncState：成功/失败为终态，中间态/空为假', () => {
  assert.equal(isTerminalAsyncState({ status: 'completed' }), true);
  assert.equal(isTerminalAsyncState({ status: 'success' }), true);
  assert.equal(isTerminalAsyncState({ status: 'succeeded' }), true);
  assert.equal(isTerminalAsyncState({ status: 'SUCCESS' }), true);
  assert.equal(isTerminalAsyncState({ status: 'failed' }), true);
  assert.equal(isTerminalAsyncState({ status: 'failure' }), true);
  assert.equal(isTerminalAsyncState({ status: 'cancelled' }), true);
  assert.equal(isTerminalAsyncState({ status: 'canceled' }), true);
  assert.equal(isTerminalAsyncState({ status: 'expired' }), true);
  assert.equal(isTerminalAsyncState({ status: 'error' }), true);
  assert.equal(isTerminalAsyncState({ data: { task_status: 'completed' } }), true);
  assert.equal(isTerminalAsyncState({ status: 'processing' }), false);
  assert.equal(isTerminalAsyncState({ status: 'pending' }), false);
  assert.equal(isTerminalAsyncState({ status: 'queued' }), false);
  assert.equal(isTerminalAsyncState({ status: 'submitted' }), false);
  assert.equal(isTerminalAsyncState({ status: 'running' }), false);
  assert.equal(isTerminalAsyncState({ status: 'in_progress' }), false);
  assert.equal(isTerminalAsyncState(null), false);
  assert.equal(isTerminalAsyncState('whatever'), false);
});
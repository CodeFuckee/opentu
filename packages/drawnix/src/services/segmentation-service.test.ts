/**
 * segmentation-service 单元测试:mock functions.invoke,
 * 覆盖正常 encode/segment、各错误形态(supabase-js 两种非 2xx 形态)、
 * 负载字段缺失。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SegmentationError,
  encodeImageForSegmentation,
  segmentWithPoints,
} from './segmentation-service';

type InvokeMock = ReturnType<typeof vi.fn>;

function makeClient(invokeMock: InvokeMock) {
  return { functions: { invoke: invokeMock } } as never;
}

const OK_ENCODE = {
  sessionId: '01234567-89ab-cdef-0123-456789abcdef',
  width: 1024,
  height: 768,
  device: 'cuda',
  encodeMs: 300,
};

const OK_SEGMENT = {
  maskPngB64: 'aWRl',
  score: 0.99,
  maskWidth: 1024,
  maskHeight: 768,
  decodeMs: 60,
};

describe('encodeImageForSegmentation', () => {
  it('正常:透传 action=encode 并映射字段', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: OK_ENCODE, error: null });
    const out = await encodeImageForSegmentation(makeClient(invoke), 'aGVsbG8=');
    expect(out).toEqual(OK_ENCODE);
    expect(invoke).toHaveBeenCalledWith('image-segmentation', {
      body: { action: 'encode', imageB64: 'aGVsbG8=' },
    });
  });

  it('非 2xx(context Response 形态):404 映射 session_not_found', async () => {
    const res = new Response(JSON.stringify({ error: 'session_not_found', message: '过期' }), {
      status: 404,
    });
    const invoke = vi.fn().mockResolvedValue({ data: null, error: { context: res } });
    await expect(
      segmentWithPoints(makeClient(invoke), 'sid', [{ x: 1, y: 1, label: 1 }])
    ).rejects.toMatchObject({ code: 'session_not_found', message: '过期', status: 404 });
  });

  it('网络异常(invoke 抛出)→ service_unavailable', async () => {
    const invoke = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      encodeImageForSegmentation(makeClient(invoke), 'aGVsbG8=')
    ).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('错误无 context 时按 message 透传 service_unavailable', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: null, error: new Error('relay error') });
    await expect(
      encodeImageForSegmentation(makeClient(invoke), 'aGVsbG8=')
    ).rejects.toBeInstanceOf(SegmentationError);
  });

  it('负载非对象 → bad_payload', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: 'nope', error: null });
    await expect(
      encodeImageForSegmentation(makeClient(invoke), 'aGVsbG8=')
    ).rejects.toMatchObject({ code: 'bad_payload' });
  });

  it('字段缺失 → bad_payload', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: { sessionId: 'x' }, error: null });
    await expect(
      encodeImageForSegmentation(makeClient(invoke), 'aGVsbG8=')
    ).rejects.toMatchObject({ code: 'bad_payload' });
  });
});

describe('segmentWithPoints', () => {
  it('正常:点集取整并透传 labels', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: OK_SEGMENT, error: null });
    const out = await segmentWithPoints(makeClient(invoke), 'sid', [
      { x: 10.4, y: 20.6, label: 1 },
      { x: 5, y: 6, label: 0 },
    ]);
    expect(out).toEqual(OK_SEGMENT);
    const body = invoke.mock.calls[0][1].body;
    expect(body.points).toEqual([
      [10, 21],
      [5, 6],
    ]);
    expect(body.labels).toEqual([1, 0]);
  });

  it('空点集直接 bad_request,不发起请求', async () => {
    const invoke = vi.fn();
    await expect(
      segmentWithPoints(makeClient(invoke), 'sid', [])
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('带 box 时透传', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: OK_SEGMENT, error: null });
    await segmentWithPoints(makeClient(invoke), 'sid', [{ x: 1, y: 1, label: 1 }], [
      0, 0, 10, 10,
    ]);
    expect(invoke.mock.calls[0][1].body.box).toEqual([0, 0, 10, 10]);
  });
});

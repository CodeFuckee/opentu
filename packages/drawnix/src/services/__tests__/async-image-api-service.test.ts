import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock('../../utils/settings-manager', () => ({
  resolveInvocationRoute: vi.fn(() => ({
    profileId: 'runtime',
    profileName: 'Runtime',
    providerType: 'custom',
    baseUrl: 'https://gateway.example.com/v1',
    apiKey: 'secret',
  })),
}));

vi.mock('../provider-routing', () => ({
  resolveInvocationPlanFromRoute: vi.fn(() => null),
  providerTransport: {
    send: mocks.send,
  },
}));

describe('async-image-api-service', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('submits async image masks as multipart mask field', async () => {
    mocks.send.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'async-image-task-1',
          object: 'video',
          model: 'gpt-image-async',
          status: 'completed',
          progress: 100,
          created_at: 1,
          url: 'https://cdn.example.com/out.png',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    ).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'async-image-task-1',
          object: 'video',
          model: 'gpt-image-async',
          status: 'completed',
          progress: 100,
          created_at: 1,
          url: 'https://cdn.example.com/out.png',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const { asyncImageAPIService } = await import('../async-image-api-service');

    await asyncImageAPIService.generateWithPolling(
      {
        model: 'gpt-image-async',
        prompt: 'edit masked area',
        size: '1:1',
        referenceImages: ['data:image/png;base64,YWJj'],
        maskImage: 'data:image/png;base64,bWFzaw==',
      },
      {
        interval: 1,
        maxAttempts: 1,
      }
    );

    expect(mocks.send).toHaveBeenCalledTimes(2);
    const request = mocks.send.mock.calls[0]?.[1];
    expect(request.body).toBeInstanceOf(FormData);
    const formData = request.body as FormData;
    expect(formData.get('input_reference')).toBeInstanceOf(Blob);
    expect(formData.get('mask')).toBeInstanceOf(Blob);
  });

  it('options.taskId 透传到每次 transport 请求（提交与轮询）', async () => {
    const completed = () =>
      new Response(
        JSON.stringify({
          id: 'async-image-task-1',
          object: 'video',
          model: 'gpt-image-async',
          status: 'completed',
          progress: 100,
          created_at: 1,
          url: 'https://cdn.example.com/out.png',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    mocks.send.mockResolvedValueOnce(completed()).mockResolvedValueOnce(completed());

    const { asyncImageAPIService } = await import('../async-image-api-service');
    await asyncImageAPIService.generateWithPolling(
      { model: 'gpt-image-async', prompt: 'x' },
      { interval: 1, maxAttempts: 1, taskId: 'T9' }
    );

    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[0]?.[1].taskId).toBe('T9');
    expect(mocks.send.mock.calls[1]?.[1].taskId).toBe('T9');
  });
});

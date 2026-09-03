// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

describe('UserMessageBubble', () => {
  // 该测试动态 import 组件模块，全量并发跑（4 个 vitest 项目 x ~19 workers）时
  // 模块 transform 可能超过默认 5s 超时（单独跑约 800ms），放宽到 30s 防偶发。
  it('click image triggers preview callback', async () => {
    const onPreviewImages = vi.fn();
    const { UserMessageBubble } = await import('../UserMessageBubble');

    render(
      <UserMessageBubble
        message={{
          id: 'msg-1',
          role: 'user',
          parts: [
            {
              type: 'data-file',
              data: {
                url: '/image-1.png',
                filename: 'image-1.png',
                mediaType: 'image/png',
              },
            },
          ],
        } as never}
        onPreviewImages={onPreviewImages}
      />
    );

    fireEvent.click(screen.getByAltText('image-1.png'));

    expect(onPreviewImages).toHaveBeenCalledTimes(1);
    expect(onPreviewImages.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({
        id: 'msg-1-image-0',
        url: '/image-1.png',
        type: 'image',
        alt: 'image-1.png',
      }),
    ]);
    expect(onPreviewImages.mock.calls.at(-1)?.[1]).toBe(0);
  }, 30_000);
});

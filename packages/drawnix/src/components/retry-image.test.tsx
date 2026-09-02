// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RetryImage } from './retry-image';

vi.mock('@aitu/utils', () => ({
  normalizeImageDataUrl: (value: string) => value,
}));

vi.mock('../services/unified-cache-service', () => ({
  unifiedCacheService: {
    getCachedBlob: vi.fn(),
  },
}));

describe('RetryImage', () => {
  afterEach(() => {
    cleanup();
  });

  it('关闭 skeleton 时加载中的图片保持可见', () => {
    render(
      <RetryImage
        src="https://example.com/preview.png"
        alt="结果预览"
        showSkeleton={false}
      />
    );

    expect(screen.getByAltText('结果预览')).toHaveProperty(
      'style.opacity',
      '1'
    );
  });

  it('开启 skeleton 时图片加载完成后再淡入', () => {
    render(<RetryImage src="https://example.com/preview.png" alt="结果预览" />);

    const image = screen.getByAltText('结果预览');
    expect(image).toHaveProperty('style.opacity', '0');

    fireEvent.load(image);

    expect(image).toHaveProperty('style.opacity', '1');
  });
});

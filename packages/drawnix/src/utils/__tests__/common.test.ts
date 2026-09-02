import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeToImage } from '../common';

const { getElementGMock, hasMountedMock, toImageMock } = vi.hoisted(() => ({
  getElementGMock: vi.fn(),
  hasMountedMock: vi.fn(),
  toImageMock: vi.fn(),
}));

vi.mock('@plait/core', () => ({
  IS_APPLE: false,
  IS_MAC: false,
  PlaitElement: {
    getElementG: getElementGMock,
    hasMounted: hasMountedMock,
  },
  toImage: toImageMock,
}));

function createMountedElementG(imageUrl: string): SVGGElement {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const foreignObject = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'foreignObject'
  );
  const wrapper = document.createElement('div');
  const image = document.createElement('img');

  image.setAttribute('src', imageUrl);
  wrapper.appendChild(image);
  foreignObject.appendChild(wrapper);
  g.appendChild(foreignObject);

  return g;
}

describe('safeToImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('falls back failed mounted DOM images to transparent PNG during toImage', async () => {
    const imageUrl = 'https://media.example.com/missing.png';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('Failed to fetch'));

    vi.stubGlobal('fetch', fetchMock);
    hasMountedMock.mockReturnValue(true);
    getElementGMock.mockReturnValue(createMountedElementG(imageUrl));
    toImageMock.mockImplementation(async () => {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      return `${blob.type}:${blob.size}`;
    });

    const result = await safeToImage(
      { children: [{ id: 'image-1' }] } as any,
      {}
    );

    expect(result).toMatch(/^image\/png:\d+$/);
    expect(fetchMock).toHaveBeenCalledWith(imageUrl, undefined);
    expect(window.fetch).toBe(fetchMock);
  });
});

/**
 * #103 拍平前置:虚拟 URL 图片 DOM src 临时内联为 dataURL(TDD 先行)。
 *
 * 背景(用户实测 bug):内网 HTTP 无 SW,toImage 序列化渲染时虚拟路径
 * (/__aitu_cache__/、/asset-library/)fetch 落服务器 404,safeToImage 将其
 * 替换为透明 PNG 占位——拍平结果丢失原图、只剩 http 直链的叠加素材。
 * 修法:渲染前把虚拟 src 从缓存 blob 解析成 dataURL 临时替换,渲染后恢复。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  inlineVirtualImageSrcs,
  blobToDataUrl,
  isInlineableUrl,
} from './flatten-dom-prepare';

const getCachedBlobMock = vi.fn();

vi.mock('../../services/unified-cache-service', () => ({
  unifiedCacheService: {
    getCachedBlob: (...args: unknown[]) => getCachedBlobMock(...args),
  },
}));

function blobToDataUrlHelper(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

beforeEach(() => {
  getCachedBlobMock.mockReset();
});

describe('blobToDataUrl', () => {
  it('Blob → data:text/plain;base64,xxx', async () => {
    const url = await blobToDataUrl(new Blob(['hi'], { type: 'text/plain' }));
    expect(url).toMatch(/^data:text\/plain;base64,/);
  });
});

describe('inlineVirtualImageSrcs', () => {
  function makeImg(src: string): HTMLImageElement {
    const img = document.createElement('img');
    img.setAttribute('src', src);
    document.body.appendChild(img);
    return img;
  }

  it('虚拟 src 命中缓存 → 临时替换为 dataURL,restore 恢复原值', async () => {
    const png = new Blob([new Uint8Array([1])], { type: 'image/png' });
    getCachedBlobMock.mockResolvedValue(png);
    const img = makeImg('/__aitu_cache__/image/content-abc.png');
    const restore = await inlineVirtualImageSrcs([img]);
    const during = img.getAttribute('src');
    expect(during).toMatch(/^data:image\/png;base64,/);
    expect(during).not.toContain('__aitu_cache__');
    restore();
    expect(img.getAttribute('src')).toBe('/__aitu_cache__/image/content-abc.png');
  });

  it('/asset-library/ 虚拟路径同样内联', async () => {
    getCachedBlobMock.mockResolvedValue(
      new Blob([new Uint8Array([2])], { type: 'image/png' })
    );
    const img = makeImg('/asset-library/xxx.png');
    const restore = await inlineVirtualImageSrcs([img]);
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    restore();
    expect(img.getAttribute('src')).toBe('/asset-library/xxx.png');
  });

  it('缓存 miss → 保持原 src 不动(渲染退化但不中断,行为同现状)', async () => {
    getCachedBlobMock.mockResolvedValue(null);
    const img = makeImg('/__aitu_cache__/image/missing.png');
    const restore = await inlineVirtualImageSrcs([img]);
    expect(img.getAttribute('src')).toBe('/__aitu_cache__/image/missing.png');
    restore();
    expect(img.getAttribute('src')).toBe('/__aitu_cache__/image/missing.png');
  });

  it('http 直链与 dataURL 不触碰', async () => {
    const httpImg = makeImg('http://10.37.80.25:8021/storage/v1/object/public/ai-outputs/a.png');
    const dataImg = makeImg('data:image/png;base64,xxx');
    await inlineVirtualImageSrcs([httpImg, dataImg]);
    expect(getCachedBlobMock).not.toHaveBeenCalled();
    expect(httpImg.getAttribute('src')).toContain('ai-outputs');
    expect(dataImg.getAttribute('src')).toBe('data:image/png;base64,xxx');
  });

  it('svg image 节点的 href/xlink:href 同样内联并恢复', async () => {
    getCachedBlobMock.mockResolvedValue(
      new Blob([new Uint8Array([3])], { type: 'image/png' })
    );
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    image.setAttribute('href', '/__aitu_cache__/image/svg-pic.png');
    svg.appendChild(image);
    document.body.appendChild(svg);
    const restore = await inlineVirtualImageSrcs([svg]);
    expect(image.getAttribute('href')).toMatch(/^data:image\/png;base64,/);
    restore();
    expect(image.getAttribute('href')).toBe('/__aitu_cache__/image/svg-pic.png');
  });

  it('getCachedBlob 抛错 → 该节点保持原样,其余节点继续处理', async () => {
    getCachedBlobMock.mockImplementation((url: string) =>
      url.includes('bad') ? Promise.reject(new Error('idb broken')) : Promise.resolve(new Blob([new Uint8Array([4])], { type: 'image/png' }))
    );
    const bad = makeImg('/__aitu_cache__/image/bad.png');
    const good = makeImg('/__aitu_cache__/image/good.png');
    const restore = await inlineVirtualImageSrcs([bad, good]);
    expect(bad.getAttribute('src')).toBe('/__aitu_cache__/image/bad.png');
    expect(good.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    restore();
  });
});

// 消除未使用告警(jsdom 环境直读 helper 验证同实现)
void blobToDataUrlHelper;

describe('isInlineableUrl(需内联的 URL 形态)', () => {
  it('虚拟路径与 blob: 需内联;http/data: 不需要', () => {
    expect(isInlineableUrl('/__aitu_cache__/image/x.png')).toBe(true);
    expect(isInlineableUrl('/asset-library/a.png')).toBe(true);
    expect(isInlineableUrl('blob:http://10.37.80.175:7200/eaa31e6f')).toBe(true);
    expect(isInlineableUrl('http://10.37.80.25:8021/storage/v1/object/public/ai-outputs/a.png')).toBe(false);
    expect(isInlineableUrl('data:image/png;base64,xxx')).toBe(false);
    expect(isInlineableUrl('https://cdn.example.com/a.jpg')).toBe(false);
  });
});

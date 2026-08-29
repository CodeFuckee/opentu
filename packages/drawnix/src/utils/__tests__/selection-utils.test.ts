import { describe, expect, it, vi } from 'vitest';
import {
  extractImagesFromElementForAI,
  extractTextFromElement,
  getImageTransformPromptContext,
  isGraphicsElement,
  processSelectedContentForAI,
} from '../selection-utils';
import { FreehandShape } from '../../plugins/freehand/type';

const mocks = vi.hoisted(() => ({
  cacheMediaFromBlob: vi.fn(async (url: string) => url),
  getImageForAI: vi.fn(),
}));

vi.mock('../../services/unified-cache-service', () => ({
  unifiedCacheService: {
    cacheMediaFromBlob: mocks.cacheMediaFromBlob,
    getImageForAI: mocks.getImageForAI,
  },
}));

function createMockMaskCanvas() {
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    restore: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    set fillStyle(_value: string) {},
    set strokeStyle(_value: string) {},
    set lineWidth(_value: number) {},
    set lineCap(_value: CanvasLineCap) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set globalCompositeOperation(_value: GlobalCompositeOperation) {},
  } as unknown as CanvasRenderingContext2D;

  return {
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback) => {
      callback(new Blob([new Uint8Array(128)], { type: 'image/png' }));
    }),
  } as unknown as HTMLCanvasElement;
}

describe('selection-utils', () => {
  describe('isGraphicsElement', () => {
    it('蒙版画笔不作为普通图形合成', () => {
      const board = { children: [] };
      expect(
        isGraphicsElement(board as any, {
          id: 'mask-1',
          type: 'freehand',
          shape: FreehandShape.mask,
          points: [
            [0, 0],
            [10, 10],
          ],
        } as any)
      ).toBe(false);

      expect(
        isGraphicsElement(board as any, {
          id: 'pen-1',
          type: 'freehand',
          shape: FreehandShape.feltTipPen,
          points: [
            [0, 0],
            [10, 10],
          ],
        } as any)
      ).toBe(true);
    });
  });

  describe('extractTextFromElement', () => {
    it('应该将 markdown card 的标题和正文作为文本提取', () => {
      const result = extractTextFromElement({
        id: 'card-1',
        type: 'card',
        title: '需求总结',
        body: '## 正文\n- 第一条\n- 第二条',
        fillColor: '#fff',
        points: [
          [0, 0],
          [100, 100],
        ],
        children: [],
      } as any);

      expect(result).toBe('# 需求总结\n## 正文\n- 第一条\n- 第二条');
    });

    it('应该在 card 没有标题时仍提取 markdown 正文', () => {
      const result = extractTextFromElement({
        id: 'card-2',
        type: 'card',
        body: '只保留正文',
        fillColor: '#fff',
        points: [
          [0, 0],
          [100, 100],
        ],
        children: [],
      } as any);

      expect(result).toBe('只保留正文');
    });
  });

  describe('extractImagesFromElementForAI', () => {
    it('单选图片时应该导出相交的蒙版画笔', async () => {
      const createElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
        if (tagName === 'canvas') {
          return createMockMaskCanvas() as unknown as HTMLElement;
        }
        return createElement(tagName);
      });

      const image = {
        id: 'image-1',
        type: 'image',
        url: 'https://example.com/source.png',
        angle: 0,
        width: 100,
        height: 50,
        points: [
          [0, 0],
          [100, 50],
        ],
      };
      const mask = {
        id: 'mask-1',
        type: 'freehand',
        shape: FreehandShape.mask,
        points: [
          [10, 10],
          [40, 20],
        ],
        strokeWidth: 8,
      };
      const board = {
        children: [image, mask],
        getRectangle: (element: { points: number[][] }) => ({
          x: element.points[0][0],
          y: element.points[0][1],
          width: element.points[1][0] - element.points[0][0],
          height: element.points[1][1] - element.points[0][1],
        }),
      };

      const result = await processSelectedContentForAI(board as any, [
        'image-1',
      ]);

      expect(result.remainingImages).toHaveLength(1);
      expect(result.remainingImages[0].url).toBe('https://example.com/source.png');
      expect(result.maskImage).toMatch(/^\/__aitu_cache__\/image\/ai-mask-/);
      expect(result.graphicsImage).toBeUndefined();

      vi.restoreAllMocks();
    });

    it('应该保持 3D 变换图片发送给 AI 的参考图为原图 URL', async () => {
      const element = {
        id: 'image-1',
        type: 'image',
        url: 'https://example.com/source.png',
        angle: Math.PI / 6,
        transform3d: {
          rotateX: 12,
          rotateY: -34,
          perspective: 900,
        },
        points: [
          [0, 0],
          [120, 80],
        ],
      };
      const board = {
        children: [element],
        getRectangle: () => ({ x: 0, y: 0, width: 120, height: 80 }),
      };

      const images = await extractImagesFromElementForAI(
        board as any,
        element as any
      );

      expect(images).toHaveLength(1);
      expect(images[0].url).toBe('https://example.com/source.png');
      expect(images[0].name).toMatch(/^draw-image-/);
    });

    it('单选虚拟 URL 画布图片时应该把参考图解析为可展示的 dataURL', async () => {
      // 模拟 Cache Storage 中存在原始 blob：SW 未接管页面时虚拟 URL 无法被 <img> 直接加载
      mocks.getImageForAI.mockResolvedValueOnce({
        type: 'base64',
        value: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      });

      const element = {
        id: 'image-virtual',
        type: 'image',
        url: '/asset-library/virtual-image.png',
        angle: 0,
        width: 100,
        height: 50,
        points: [
          [0, 0],
          [100, 50],
        ],
      };
      const board = {
        children: [element],
        getRectangle: () => ({ x: 0, y: 0, width: 100, height: 50 }),
      };

      const images = await extractImagesFromElementForAI(
        board as any,
        element as any
      );

      expect(images).toHaveLength(1);
      expect(images[0].url).toBe('data:image/png;base64,ZmFrZS1pbWFnZQ==');
      expect(images[0].name).toMatch(/^draw-image-/);
    });

    it('虚拟 URL 图片在缓存中不存在时应保持原 URL 降级', async () => {
      mocks.getImageForAI.mockResolvedValueOnce({
        type: 'url',
        value: '/asset-library/missing.png',
      });

      const element = {
        id: 'image-virtual-missing',
        type: 'image',
        url: '/asset-library/missing.png',
        angle: 0,
        width: 100,
        height: 50,
        points: [
          [0, 0],
          [100, 50],
        ],
      };
      const board = {
        children: [element],
        getRectangle: () => ({ x: 0, y: 0, width: 100, height: 50 }),
      };

      const images = await extractImagesFromElementForAI(
        board as any,
        element as any
      );

      expect(images).toHaveLength(1);
      expect(images[0].url).toBe('/asset-library/missing.png');
    });

    it('生图对话框选中外链图片时不应触发虚拟 URL 解析', async () => {
      mocks.getImageForAI.mockClear();
      const element = {
        id: 'image-remote',
        type: 'image',
        url: 'https://example.com/remote.png',
        angle: 0,
        width: 100,
        height: 50,
        points: [
          [0, 0],
          [100, 50],
        ],
      };
      const board = {
        children: [element],
        getRectangle: () => ({ x: 0, y: 0, width: 100, height: 50 }),
      };

      const images = await extractImagesFromElementForAI(
        board as any,
        element as any
      );

      expect(images).toHaveLength(1);
      expect(images[0].url).toBe('https://example.com/remote.png');
      expect(mocks.getImageForAI).not.toHaveBeenCalled();
    });

    it('processSelectedContentForAI 选中虚拟 URL 图片时应输出可展示的参考图', async () => {
      mocks.getImageForAI.mockResolvedValueOnce({
        type: 'base64',
        value: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
      });

      const element = {
        id: 'image-virtual-dialog',
        type: 'image',
        url: '/asset-library/dialog-image.png',
        angle: 0,
        width: 100,
        height: 50,
        points: [
          [0, 0],
          [100, 50],
        ],
      };
      const board = {
        children: [element],
        getRectangle: () => ({ x: 0, y: 0, width: 100, height: 50 }),
      };

      const result = await processSelectedContentForAI(board as any, [
        'image-virtual-dialog',
      ]);

      expect(result.remainingImages).toHaveLength(1);
      expect(result.remainingImages[0].url).toBe(
        'data:image/png;base64,ZmFrZS1pbWFnZQ=='
      );
    });

    it('应该只把 3D 变换转换成自然机位提示词，忽略 2D 平面旋转', () => {
      const context = getImageTransformPromptContext({
        id: 'image-1',
        type: 'image',
        url: 'https://example.com/source.png',
        angle: Math.PI / 6,
        transform3d: {
          rotateX: 12,
          rotateY: -34,
          perspective: 900,
        },
        points: [
          [0, 0],
          [120, 80],
        ],
      } as any);

      expect(context).toContain('三维机位重绘硬约束');
      expect(context).toContain('先忽略参考图在画布上的平面旋转角度');
      expect(context).toContain('输出必须是满幅矩形的自然成片');
      expect(context).toContain('reconstruct the same scene in 3D');
      expect(context).toContain('do not render the source image as a tilted photo');
      expect(context).toContain('构图迁移方向');
      expect(context).toContain('整体构图趋势：视觉重心从左上向右下迁移');
      expect(context).toContain('左右站位必须轻微换边');
      expect(context).toContain('从参考图偏左的关系迁移到画面右侧或右前方');
      expect(context).toContain('人物在画面中的位置也要跨到右侧');
      expect(context).toContain('上下站位必须轻微换位');
      expect(context).toContain('从参考图偏上的关系迁移到画面下侧或下前方');
      expect(context).toContain('相机从主体右侧轻微偏移观察');
      expect(context).toContain('轻微低机位仰视');
      expect(context).toContain('使用自然中等透视');
      expect(context).toContain('建立三维空间和主体骨架');
      expect(context).toContain('主体位置和姿态必须出现可见变化');
      expect(context).toContain('如果画面是在白色/空白背景上摆放一张倾斜矩形图片');
      expect(context).toContain('这个结果无效');
      expect(context).not.toContain('canvas-transform-guide');
      expect(context).not.toContain('构图主轴');
      expect(context).not.toContain('rotateX 12°');
      expect(context).not.toContain('rotateY -34°');
      expect(context).not.toContain('perspective 900px');
    });

    it('应该为越过侧面的图片补充侧后方语义构图约束', () => {
      const context = getImageTransformPromptContext({
        id: 'TicMY',
        type: 'image',
        url: 'https://example.com/source.png',
        angle: (36.92 * Math.PI) / 180,
        transform3d: {
          rotateX: 0,
          rotateY: 124,
          perspective: 800,
        },
        points: [
          [0, 0],
          [120, 80],
        ],
      } as any);

      expect(context).toContain('左右站位必须明显换边');
      expect(context).toContain('整体构图趋势：视觉重心从右向左迁移');
      expect(context).toContain('从参考图偏右的关系迁移到画面左侧或左前方');
      expect(context).toContain('相机位于主体左侧侧后方');
      expect(context).toContain('侧后方');
      expect(context).toContain('脸部可见范围');
      expect(context).toContain('前后遮挡');
      expect(context).toContain('重新计算主体、道具、前景、中景和背景');
      expect(context).toContain('主体不能保持原参考图的正面摆放');
      expect(context).not.toContain('构图主轴');
      expect(context).not.toContain('rotateY 124°');
      expect(context).not.toContain('梯形贴图');
    });

    it('没有 3D 旋转参数时不额外生成提示词上下文', () => {
      const context = getImageTransformPromptContext({
        id: 'image-plain',
        type: 'image',
        url: 'https://example.com/source.png',
        points: [
          [0, 0],
          [120, 80],
        ],
      } as any);

      expect(context).toBeNull();
    });

    it('只有 2D 平面旋转时不额外生成提示词上下文', () => {
      const context = getImageTransformPromptContext({
        id: 'image-2d-only',
        type: 'image',
        url: 'https://example.com/source.png',
        angle: Math.PI / 6,
        points: [
          [0, 0],
          [120, 80],
        ],
      } as any);

      expect(context).toBeNull();
    });
  });
});

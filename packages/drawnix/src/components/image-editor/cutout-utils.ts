/**
 * 智能抠图工具:纯坐标换算(可单测)+ DOM 合成(浏览器路径)。
 *
 * 服务端 /encode 会把图片长边缩到 ≤1024,返回 width/height;点击交互在
 * 原图坐标系上进行,发请求前统一换到编码坐标系。
 */
import type { SegmentationMask, SegmentationSession } from '../../services/segmentation-service';

export interface CutoutPoint {
  x: number;
  y: number;
  /** 1=正点(要它) 0=负点(不要它) */
  label: 0 | 1;
}

export function clampPoint(v: number, max: number): number {
  return Math.max(0, Math.min(max - 1, Math.round(v)));
}

/** 点击位置(显示矩形内像素)→ 原图像素坐标 */
export function pointFromClick(
  clickX: number,
  clickY: number,
  rectW: number,
  rectH: number,
  imgW: number,
  imgH: number
): { x: number; y: number } {
  const x = clampPoint((clickX / Math.max(1, rectW)) * imgW, imgW);
  const y = clampPoint((clickY / Math.max(1, rectH)) * imgH, imgH);
  return { x, y };
}

/** 原图像素坐标 → 编码尺寸坐标系(等比,夹紧) */
export function scaleToEncodeCoords(
  p: { x: number; y: number },
  naturalW: number,
  naturalH: number,
  encW: number,
  encH: number
): { x: number; y: number } {
  return {
    x: clampPoint((p.x / Math.max(1, naturalW)) * encW, encW),
    y: clampPoint((p.y / Math.max(1, naturalH)) * encH, encH),
  };
}

/** 编码系点集 → 显示用百分比标记(供绝对定位) */
export function toMarkers(
  points: ReadonlyArray<CutoutPoint>,
  encW: number,
  encH: number
): Array<{ x: number; y: number; label: 0 | 1 }> {
  return points.map((p) => ({
    x: (p.x / Math.max(1, encW)) * 100,
    y: (p.y / Math.max(1, encH)) * 100,
    label: p.label,
  }));
}

/** 编码会话存在时把点集映射到编码系(会话缺省时原样返回) */
export function pointsForRequest(
  points: ReadonlyArray<CutoutPoint>,
  naturalW: number,
  naturalH: number,
  session: Pick<SegmentationSession, 'width' | 'height'> | null
): CutoutPoint[] {
  if (!session) return [];
  return points.map((p) => {
    const scaled = scaleToEncodeCoords(p, naturalW, naturalH, session.width, session.height);
    return { ...scaled, label: p.label };
  });
}

// ---------------------------------------------------------------- DOM 路径(浏览器)

/** 原图元素 → 编码用 JPEG base64(长边 ≤1024,质量 0.85,无 alpha) */
export function prepareEncodePayload(
  image: HTMLImageElement,
  maxEdge = 1024,
  quality = 0.85
): string {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布上下文');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/** 灰度掩码 PNG(255=选中)→ 半透明蓝色覆盖层 dataURL(alpha 可调:预览淡/正式浓) */
export function buildMaskOverlayUrl(maskPngDataUrl: string, alpha = 110): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建画布上下文'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      try {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
          const on = px[i] > 128; // 灰度 R 通道
          px[i] = 24;
          px[i + 1] = 144;
          px[i + 2] = 255;
          px[i + 3] = on ? alpha : 0;
        }
        ctx.putImageData(data, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('掩码处理失败'));
      }
    };
    img.onerror = () => reject(new Error('掩码图加载失败'));
    img.src = maskPngDataUrl;
  });
}

/**
 * 原图 + 掩码 → 全分辨率透明底 PNG dataURL。
 * 掩码先按需羽化(ctx.filter blur),再把亮度写进 alpha,最后
 * destination-in 保留原图中选中区域。跨源污染画布会抛 SecurityError,
 * 由调用方(以 crossOrigin=anonymous 重载原图后)重试。
 */
export function composeCutoutDataUrl(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maskPngDataUrl: string,
  featherPx = 0
): Promise<string> {
  return new Promise((resolve, reject) => {
    const maskImg = new Image();
    maskImg.onload = () => {
      try {
        const out = document.createElement('canvas');
        out.width = srcW;
        out.height = srcH;
        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('无法创建画布上下文');
        ctx.drawImage(source, 0, 0, srcW, srcH);

        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = srcW;
        maskCanvas.height = srcH;
        const mctx = maskCanvas.getContext('2d');
        if (!mctx) throw new Error('无法创建画布上下文');
        if (featherPx > 0) {
          mctx.filter = `blur(${featherPx}px)`;
        }
        // 浏览器双线性上采样掩码到原图分辨率
        mctx.drawImage(maskImg, 0, 0, srcW, srcH);
        mctx.filter = 'none';
        const data = mctx.getImageData(0, 0, srcW, srcH);
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
          px[i + 3] = px[i]; // 灰度亮度 → alpha
          px[i] = px[i + 1] = px[i + 2] = 255;
        }
        mctx.putImageData(data, 0, 0);

        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(maskCanvas, 0, 0);
        resolve(out.toDataURL('image/png'));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('合成失败'));
      }
    };
    maskImg.onerror = () => reject(new Error('掩码图加载失败'));
    maskImg.src = maskPngDataUrl;
  });
}

/** maskPngB64 → dataURL(掩码两处入口统一转换) */
export function maskB64ToDataUrl(mask: Pick<SegmentationMask, 'maskPngB64'>): string {
  return `data:image/png;base64,${mask.maskPngB64}`;
}

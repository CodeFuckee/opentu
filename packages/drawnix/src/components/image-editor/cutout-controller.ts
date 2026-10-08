/**
 * 智能抠图交互控制器:编码会话生命周期、点集管理、分割、结果合成。
 * 掩码两层:正式层(点击确认后)+悬停预览层(鼠标移动实时"如果在这里点击
 * 会选中什么",带当前点集请求,所见即所得)。UI(CutoutStage/CutoutPanel)
 * 只做展示与事件转发,逻辑集中于此便于测试。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getOfficialLibraryConfig } from '../official-library/runtime';
import {
  SegmentationError,
  SegmentationSession,
  encodeImageForSegmentation,
  segmentWithPoints,
} from '../../services/segmentation-service';
import {
  buildMaskOverlayUrl,
  composeCutoutDataUrl,
  maskB64ToDataUrl,
  type CutoutPoint,
  pointsForRequest,
  prepareEncodePayload,
} from './cutout-utils';

const SEGMENT_DEBOUNCE_MS = 220;
/** 悬停预览节流:时间间隔 + 最小移动距离(原图坐标系) */
const HOVER_INTERVAL_MS = 150;
const HOVER_MIN_MOVE_PX = 8;

export interface CutoutState {
  session: SegmentationSession | null;
  encoding: boolean;
  segmenting: boolean;
  composing: boolean;
  error: string | null;
  points: CutoutPoint[];
  maskOverlayUrl: string | null;
  hoverOverlayUrl: string | null;
  score: number | null;
  tool: 'add' | 'remove';
}

const INITIAL_STATE: CutoutState = {
  session: null,
  encoding: false,
  segmenting: false,
  composing: false,
  error: null,
  points: [],
  maskOverlayUrl: null,
  hoverOverlayUrl: null,
  score: null,
  tool: 'add',
};

export function useCutoutController(
  enabled: boolean,
  getImageEl: () => HTMLImageElement | null
) {
  const [state, setState] = useState<CutoutState>(INITIAL_STATE);

  const maskDataUrlRef = useRef<string | null>(null);
  const segmentSeqRef = useRef(0);
  const hoverSeqRef = useRef(0);
  const hoverInFlightRef = useRef(false);
  const lastHoverRef = useRef({ t: -Infinity, x: -1, y: -1 });
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointsRef = useRef<CutoutPoint[]>([]);
  pointsRef.current = state.points;
  const sessionRef = useRef<SegmentationSession | null>(null);
  sessionRef.current = state.session;
  const toolRef = useRef<'add' | 'remove'>('add');
  toolRef.current = state.tool;

  const patch = useCallback((p: Partial<CutoutState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  /** 取消悬停预览:清层 + 使在途结果失效(点击/移出/复位时调用) */
  const cancelHover = useCallback(() => {
    hoverSeqRef.current++;
    hoverInFlightRef.current = false;
    lastHoverRef.current = { t: -Infinity, x: -1, y: -1 };
    if (state.hoverOverlayUrl) {
      patch({ hoverOverlayUrl: null });
    }
  }, [patch, state.hoverOverlayUrl]);

  /** 底层分割请求:preview=true 写悬停层(静默失败),否则写正式层 */
  const requestSegment = useCallback(
    async (points: CutoutPoint[], preview: boolean, retryOnStale = true) => {
      const client = getOfficialLibraryConfig()?.client;
      const image = getImageEl();
      const cur = sessionRef.current;
      if (!client || !image || !cur || points.length === 0) return;
      const seq = preview ? ++hoverSeqRef.current : ++segmentSeqRef.current;
      if (!preview) {
        // 正式请求作废悬停层(点击即锁定,预览让位)
        hoverSeqRef.current++;
        patch({ segmenting: true, error: null, hoverOverlayUrl: null });
      }
      try {
        const mask = await segmentWithPoints(
          client,
          cur.sessionId,
          pointsForRequest(points, image.naturalWidth, image.naturalHeight, cur)
        );
        const maskDataUrl = maskB64ToDataUrl(mask);
        const overlay = await buildMaskOverlayUrl(maskDataUrl, preview ? 70 : 110);
        if (preview) {
          if (seq !== hoverSeqRef.current) return;
          patch({ hoverOverlayUrl: overlay });
        } else {
          if (seq !== segmentSeqRef.current) return;
          maskDataUrlRef.current = maskDataUrl;
          patch({ segmenting: false, score: mask.score, maskOverlayUrl: overlay });
        }
      } catch (e) {
        if (preview) {
          if (seq !== hoverSeqRef.current) return;
          return; // 预览失败静默:不打断交互,下次移动重试
        }
        if (seq !== segmentSeqRef.current) return;
        if (
          e instanceof SegmentationError &&
          retryOnStale &&
          (e.code === 'session_not_found' || e.code === 'session_stale')
        ) {
          // 会话过期:自动重编码并重放当前点集
          patch({ segmenting: false });
          const ok = await encode(false);
          if (ok) await requestSegment(points, false, false);
          return;
        }
        patch({ segmenting: false, error: e instanceof Error ? e.message : '分割失败' });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch]
  );

  const encode = useCallback(
    async (resetPoints = true): Promise<boolean> => {
      const client = getOfficialLibraryConfig()?.client;
      if (!client) {
        patch({ error: '请先登录后使用智能抠图' });
        return false;
      }
      const image = getImageEl();
      if (!image || !image.naturalWidth) {
        patch({ error: '图片尚未加载完成' });
        return false;
      }
      patch({ encoding: true, error: null });
      try {
        const payload = prepareEncodePayload(image);
        const session = await encodeImageForSegmentation(client, payload);
        sessionRef.current = session;
        const next: Partial<CutoutState> = {
          encoding: false,
          session,
          maskOverlayUrl: null,
          hoverOverlayUrl: null,
          score: null,
        };
        if (resetPoints) {
          next.points = [];
          maskDataUrlRef.current = null;
        }
        patch(next);
        return true;
      } catch (e) {
        patch({
          encoding: false,
          error:
            e instanceof SegmentationError && e.code === 'service_unavailable'
              ? '抠图服务暂不可用,请稍后重试'
              : e instanceof Error
                ? e.message
                : '图片分析失败',
        });
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch]
  );

  // 进入抠图模式:自动编码一次;离开:复位
  useEffect(() => {
    if (enabled) {
      void encode(true);
    } else {
      segmentSeqRef.current++;
      hoverSeqRef.current++;
      hoverInFlightRef.current = false;
      clearTimeout(debounceTimerRef.current);
      maskDataUrlRef.current = null;
      sessionRef.current = null;
      lastHoverRef.current = { t: -Infinity, x: -1, y: -1 };
      setState(INITIAL_STATE);
    }
    return () => {
      clearTimeout(debounceTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const addPoint = useCallback(
    (label: 0 | 1, x: number, y: number) => {
      if (state.encoding) return;
      cancelHover();
      const next = [...state.points, { x, y, label }];
      patch({ points: next, error: null });
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        void requestSegment(next, false);
      }, SEGMENT_DEBOUNCE_MS);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.points, state.encoding, patch, cancelHover]
  );

  /**
   * 悬停预览:节流(间隔 + 距离)后带「已有点集 + 悬停点」请求,
   * 展示"在此点击会得到的结果"。在途请求期间丢弃新移动(下次移动再补)。
   */
  const hoverMove = useCallback(
    (x: number, y: number) => {
      if (state.encoding) return;
      const cur = sessionRef.current;
      if (!cur) return;
      const now = performance.now();
      const last = lastHoverRef.current;
      if (now - last.t < HOVER_INTERVAL_MS) return;
      if (last.x >= 0 && Math.hypot(x - last.x, y - last.y) < HOVER_MIN_MOVE_PX) return;
      if (hoverInFlightRef.current) return;
      lastHoverRef.current = { t: now, x, y };
      hoverInFlightRef.current = true;
      const hoverPoint: CutoutPoint = { x, y, label: toolRef.current === 'remove' ? 0 : 1 };
      void requestSegment([...pointsRef.current, hoverPoint], true).finally(() => {
        hoverInFlightRef.current = false;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.encoding, requestSegment]
  );

  /** 移出图片:清悬停层并使在途预览失效 */
  const hoverLeave = useCallback(() => {
    cancelHover();
  }, [cancelHover]);

  const undo = useCallback(() => {
    const next = state.points.slice(0, -1);
    patch({ points: next, error: null });
    if (next.length === 0) {
      maskDataUrlRef.current = null;
      patch({ maskOverlayUrl: null, score: null });
      return;
    }
    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(
      () => void requestSegment(next, false),
      SEGMENT_DEBOUNCE_MS
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.points, patch]);

  const clearPoints = useCallback(() => {
    clearTimeout(debounceTimerRef.current);
    segmentSeqRef.current++;
    hoverSeqRef.current++;
    maskDataUrlRef.current = null;
    patch({
      points: [],
      maskOverlayUrl: null,
      hoverOverlayUrl: null,
      score: null,
      segmenting: false,
    });
  }, [patch]);

  const setTool = useCallback((tool: 'add' | 'remove') => patch({ tool }), [patch]);

  const reencode = useCallback(() => {
    clearPoints();
    void encode(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearPoints, encode]);

  /** 合成全分辨率透明底;composing 期间 UI 置灰 */
  const confirm = useCallback(
    async (featherPx = 0): Promise<string | null> => {
      const image = getImageEl();
      const mask = maskDataUrlRef.current;
      if (!image || !image.naturalWidth || !mask) return null;
      patch({ composing: true, error: null });
      try {
        const dataUrl = await composeCutoutDataUrl(
          image,
          image.naturalWidth,
          image.naturalHeight,
          mask,
          featherPx
        );
        return dataUrl;
      } catch (e) {
        const msg =
          e instanceof DOMException && e.name === 'SecurityError'
            ? '原图跨源受限,无法读取像素'
            : e instanceof Error
              ? e.message
              : '合成失败';
        patch({ error: msg });
        return null;
      } finally {
        patch({ composing: false });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch]
  );

  return {
    ...state,
    enabled,
    addPoint,
    hoverMove,
    hoverLeave,
    undo,
    clearPoints,
    setTool,
    reencode,
    confirm,
  };
}

export type CutoutController = ReturnType<typeof useCutoutController>;

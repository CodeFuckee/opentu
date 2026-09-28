/**
 * glb 3D 预览全屏对话框(方案:docs/glb-3d-preview-design.md,#32)。
 *
 * - 本组件整体由调用方 React.lazy 按需加载,@google/model-viewer(+three)随之
 *   切独立 chunk,不进主包;关闭即卸载,随之释放 WebGL 上下文。
 * - 状态机:confirm-large(>20MB 首次打开)→ loading(进度条)→ ready;
 *   加载失败或进度 30s 无推进 → fallback(视图图 + 下载引导),不白屏。
 * - 内网 HTTP 约束:model-viewer 纯 WebGL+fetch,无 secure-context 依赖;
 *   src 为公开桶直链,不经 SW/CDN。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from 'tdesign-react';
import '@google/model-viewer';
import '../../types/glb-viewer-jsx';
import {
  advanceProgress,
  isProgressStalled,
  shouldPromptLargeFile,
  type GlbProgressState,
} from './glb-preview-utils';
import { formatFileSize } from '../../utils/asset-utils';
import './GlbModelViewerDialog.scss';

export interface GlbModelViewerDialogProps {
  glbUrl: string;
  glbName?: string | null;
  glbBytes?: number | null;
  /** 降级态展示的视图图组(与素材详情一致) */
  viewImageUrls?: string[];
  onClose: () => void;
}

type Phase = 'confirm-large' | 'loading' | 'ready' | 'fallback';

const STALL_CHECK_INTERVAL_MS = 5_000;

export function GlbModelViewerDialog({
  glbUrl,
  glbName,
  glbBytes,
  viewImageUrls = [],
  onClose,
}: GlbModelViewerDialogProps) {
  const [phase, setPhase] = useState<Phase>(() =>
    shouldPromptLargeFile(glbBytes) ? 'confirm-large' : 'loading'
  );
  const [progress, setProgress] = useState<GlbProgressState>(() => ({
    progress: 0,
    lastAdvancedAt: Date.now(),
  }));
  // 看门狗读 ref 镜像,避免在 setState updater 里产生副作用
  const progressRef = useRef(progress);
  const viewerRef = useRef<HTMLElement | null>(null);

  // model-viewer 的 CustomEvent 不走 React 合成事件,统一 ref + 原生监听
  useEffect(() => {
    if (phase !== 'loading') {
      return;
    }
    const el = viewerRef.current;
    if (!el) {
      return;
    }
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent<{ totalProgress?: number }>).detail;
      const pct =
        typeof detail?.totalProgress === 'number' ? detail.totalProgress * 100 : 0;
      const next = advanceProgress(progressRef.current, pct, Date.now());
      progressRef.current = next;
      setProgress(next);
    };
    const onLoad = () => setPhase('ready');
    const onError = () => setPhase('fallback');
    el.addEventListener('progress', onProgress);
    el.addEventListener('load', onLoad);
    el.addEventListener('error', onError);
    return () => {
      el.removeEventListener('progress', onProgress);
      el.removeEventListener('load', onLoad);
      el.removeEventListener('error', onError);
    };
  }, [phase]);

  // 进度停滞看门狗:loading 态下 30s 无推进即降级
  useEffect(() => {
    if (phase !== 'loading') {
      return;
    }
    const timer = window.setInterval(() => {
      if (isProgressStalled(progressRef.current, Date.now())) {
        setPhase('fallback');
      }
    }, STALL_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [phase]);

  const handleContinueLoad = useCallback(() => {
    progressRef.current = { progress: 0, lastAdvancedAt: Date.now() };
    setProgress(progressRef.current);
    setPhase('loading');
  }, []);

  return (
    <Dialog
      visible
      header={glbName ? `3D 预览 — ${glbName}` : '3D 预览'}
      onClose={onClose}
      footer={false}
      width="min(1100px, 94vw)"
    >
      <div className="glb-viewer-dialog">
        {phase === 'confirm-large' && (
          <div className="glb-viewer-dialog__confirm">
            <p className="glb-viewer-dialog__confirm-text">
              该模型体积
              {typeof glbBytes === 'number' ? ` ${formatFileSize(glbBytes)}` : '较大'}
              ，内网加载可能需要数十秒，是否继续？
            </p>
            <div className="glb-viewer-dialog__confirm-actions">
              <button
                type="button"
                className="glb-viewer-dialog__btn"
                onClick={onClose}
              >
                取消
              </button>
              <button
                type="button"
                className="glb-viewer-dialog__btn glb-viewer-dialog__btn--primary"
                onClick={handleContinueLoad}
              >
                继续加载
              </button>
            </div>
          </div>
        )}

        {(phase === 'loading' || phase === 'ready') && (
          <div className="glb-viewer-dialog__stage">
            {phase === 'loading' && (
              <div className="glb-viewer-dialog__progress">
                <div className="glb-viewer-dialog__progress-bar">
                  <div
                    className="glb-viewer-dialog__progress-fill"
                    style={{ width: `${progress.progress}%` }}
                  />
                </div>
                <span className="glb-viewer-dialog__progress-text">
                  {progress.progress > 0
                    ? `加载中 ${progress.progress}%`
                    : '加载中…'}
                </span>
              </div>
            )}
            <model-viewer
              ref={viewerRef}
              src={glbUrl}
              alt={glbName || '3D 模型'}
              camera-controls="true"
              auto-rotate="true"
              loading="eager"
              environment-image="neutral"
              shadow-intensity="1"
              className="glb-viewer-dialog__model"
            />
          </div>
        )}

        {phase === 'fallback' && (
          <div className="glb-viewer-dialog__fallback">
            <p className="glb-viewer-dialog__fallback-text">
              模型加载失败或超时，可关闭后重试，或直接下载查看：
            </p>
            <a
              className="glb-viewer-dialog__btn glb-viewer-dialog__btn--primary"
              href={glbUrl}
              target="_blank"
              rel="noreferrer"
              data-track="glb_preview_fallback_download"
            >
              下载 glb
            </a>
            {viewImageUrls.length > 0 && (
              <div className="glb-viewer-dialog__fallback-grid">
                {viewImageUrls.map((url) => (
                  <img key={url} src={url} alt="视图图" loading="lazy" />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export default GlbModelViewerDialog;

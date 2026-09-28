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
import { Dialog, MessagePlugin } from 'tdesign-react';
import '@google/model-viewer';
import '../../types/glb-viewer-jsx';
import {
  advanceProgress,
  isProgressStalled,
  shouldPromptLargeFile,
  type GlbProgressState,
} from './glb-preview-utils';
import { formatFileSize } from '../../utils/asset-utils';
import { insertImageFromUrl } from '../../data/image';
import { useDrawnix } from '../../hooks/use-drawnix';
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
  // 舞台容器是普通 div,ref 可靠;model-viewer 经它 querySelector 获取
  // (React 18.3 对自定义元素的 ref/className 属性挂载不可靠,实测两者都会丢失)
  const stageRef = useRef<HTMLDivElement | null>(null);
  // 已绑定监听的 model-viewer 元素(幂等标记:防止 ref callback 与重试 effect 双重绑定)
  const boundElRef = useRef<HTMLElement | null>(null);

  // 事件处理器组件生命周期内稳定(lazy init),ref callback 与重试 effect 共用
  const handlersRef = useRef<{
    progress: (event: Event) => void;
    load: () => void;
    error: () => void;
  } | null>(null);
  if (!handlersRef.current) {
    handlersRef.current = {
      progress: (event: Event) => {
        const detail = (event as CustomEvent<{ totalProgress?: number }>).detail;
        const pct =
          typeof detail?.totalProgress === 'number' ? detail.totalProgress * 100 : 0;
        const next = advanceProgress(progressRef.current, pct, Date.now());
        progressRef.current = next;
        setProgress(next);
      },
      load: () => setPhase('ready'),
      error: () => setPhase('fallback'),
    };
  }

  const tryBindViewer = useCallback((): HTMLElement | null => {
    if (boundElRef.current) {
      return boundElRef.current;
    }
    const el = stageRef.current?.querySelector('model-viewer');
    if (!el) {
      return null;
    }
    const handlers = handlersRef.current!;
    el.addEventListener('progress', handlers.progress);
    el.addEventListener('load', handlers.load);
    el.addEventListener('error', handlers.error);
    boundElRef.current = el;
    return el;
  }, []);

  /**
   * stage 的 ref callback:commit 阶段同步执行,必然早于任何异步 load/progress
   * 事件——缓存命中(二次打开)时模型秒加载,若等 paint 后的 useEffect 再绑定
   * 会错过全部事件,「加载中」永久滞留(直到 30s 看门狗误切降级)。
   */
  const bindStage = useCallback(
    (el: HTMLDivElement | null) => {
      stageRef.current = el;
      if (el) {
        tryBindViewer();
      } else {
        boundElRef.current = null;
      }
    },
    [tryBindViewer]
  );

  // 后备:ref callback 之外每 100ms 重试绑定(幂等,已绑定则立即返回)
  useEffect(() => {
    if (phase !== 'loading' || boundElRef.current) {
      return;
    }
    let cancelled = false;
    let timer = 0;
    const retry = (attempt: number) => {
      if (cancelled || tryBindViewer()) {
        return;
      }
      if (attempt < 50) {
        timer = window.setTimeout(() => retry(attempt + 1), 100);
      }
    };
    retry(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, tryBindViewer]);

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

  const { board } = useDrawnix();
  const [inserting, setInserting] = useState(false);

  // 截取当前视角(toDataURL)→ 先上传 ai-outputs 公开桶拿直链再插入画布
  // (用户拍板,与方案1 同模式:桶直链跨设备持久,任何上下文可直接加载,
  //  编辑器等消费方不 404);未登录/上传失败/超时回退 dataURL 原路径
  const handleInsertView = useCallback(async () => {
    const el = boundElRef.current;
    if (!el || !board || inserting) {
      return;
    }
    try {
      setInserting(true);
      const dataUrl = await (
        el as HTMLElement & {
          toDataURL?: (type: string) => Promise<string>;
        }
      ).toDataURL?.('image/png');
      if (!dataUrl) {
        throw new Error('model-viewer toDataURL unavailable');
      }
      let insertUrl = dataUrl;
      try {
        const { ensureGeneratedMediaArchive } = await import(
          '../../services/task-supabase-archive/service'
        );
        // 截图为本地 base64,无上游下载,仅上传耗时(内网秒级);合成 taskId 仅供去重,
        // 归档回写为 update 语义,不产生脏 task_submissions 行
        const entries = await ensureGeneratedMediaArchive(
          `glb-view-${Date.now()}`,
          [dataUrl],
          30_000
        );
        const publicUrl = entries?.find(
          (entry) => entry.sourceUrl === dataUrl && entry.publicUrl
        )?.publicUrl;
        if (publicUrl) {
          insertUrl = publicUrl;
        } else {
          console.warn(
            '[GlbModelViewerDialog] 桶上传未产出直链(未登录/失败/超时),回退本地缓存路径插入'
          );
        }
      } catch (error) {
        console.warn('[GlbModelViewerDialog] 桶上传失败,回退本地缓存路径插入:', error);
      }
      await insertImageFromUrl(board, insertUrl);
      MessagePlugin.success('已插入当前视角到画板');
    } catch (error) {
      console.error('[GlbModelViewerDialog] 插入视角失败:', error);
      MessagePlugin.error('插入画板失败，请重试');
    } finally {
      setInserting(false);
    }
  }, [board, inserting]);

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
          <div className="glb-viewer-dialog__stage" ref={bindStage}>
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
            {/* 事件与尺寸样式都经 stage 容器后代选择器/查询处理,
                不依赖 React 对自定义元素的 ref/class 挂载;
                不开自动旋转(用户拍板):手动旋转观察,避免截图瞬间角度漂移 */}
            <model-viewer
              src={glbUrl}
              alt={glbName || '3D 模型'}
              camera-controls="true"
              loading="eager"
              environment-image="neutral"
              shadow-intensity="1"
            />
            {phase === 'ready' && (
              <div className="glb-viewer-dialog__actions">
                <button
                  type="button"
                  className="glb-viewer-dialog__btn glb-viewer-dialog__btn--primary"
                  onClick={() => void handleInsertView()}
                  disabled={inserting || !board}
                  data-track="glb_preview_insert_view"
                >
                  {inserting ? '插入中…' : '插入视角到画板'}
                </button>
              </div>
            )}
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

/**
 * 抠图预览舞台:原图 + 掩码覆盖层(悬停预览层/点击确认层)+ 点标记 + 交互。
 * 鼠标移动实时预览"在此点击会选中什么"(节流在 controller),点击才锁定。
 */
import React, { useCallback, useRef } from 'react';
import { Wand2, Loader2 } from 'lucide-react';
import { pointFromClick, toMarkers } from './cutout-utils';
import type { CutoutController } from './cutout-controller';

interface CutoutStageProps {
  controller: CutoutController;
  imageUrl: string;
}

export const CutoutStage: React.FC<CutoutStageProps> = ({ controller, imageUrl }) => {
  const imgRef = useRef<HTMLImageElement | null>(null);

  const toImagePoint = useCallback((clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return pointFromClick(
      clientX - rect.left,
      clientY - rect.top,
      rect.width,
      rect.height,
      img.naturalWidth,
      img.naturalHeight
    );
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const p = toImagePoint(e.clientX, e.clientY);
      if (!p) return;
      const negative = e.altKey || controller.tool === 'remove';
      controller.addPoint(negative ? 0 : 1, p.x, p.y);
    },
    [controller, toImagePoint]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const p = toImagePoint(e.clientX, e.clientY);
      if (!p) return;
      controller.addPoint(0, p.x, p.y);
    },
    [controller, toImagePoint]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const p = toImagePoint(e.clientX, e.clientY);
      if (!p) return;
      controller.hoverMove(p.x, p.y);
    },
    [controller, toImagePoint]
  );

  const markers = controller.session
    ? toMarkers(controller.points, controller.session.width, controller.session.height)
    : [];

  return (
    <div className="cutout-stage" data-testid="cutout-stage">
      <div className="cutout-stage__canvas">
        <img
          ref={imgRef}
          src={imageUrl}
          alt="cutout"
          draggable={false}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          onMouseMove={handleMouseMove}
          onMouseLeave={controller.hoverLeave}
        />
        {controller.maskOverlayUrl && (
          <img
            className="cutout-stage__mask"
            src={controller.maskOverlayUrl}
            alt=""
            draggable={false}
            data-testid="cutout-mask-overlay"
          />
        )}
        {controller.hoverOverlayUrl && (
          <img
            className="cutout-stage__mask cutout-stage__mask--hover"
            src={controller.hoverOverlayUrl}
            alt=""
            draggable={false}
            data-testid="cutout-hover-overlay"
          />
        )}
        {markers.map((m, i) => (
          <span
            key={i}
            className={`cutout-stage__point ${
              m.label === 1 ? 'cutout-stage__point--add' : 'cutout-stage__point--remove'
            }`}
            style={{ left: `${m.x}%`, top: `${m.y}%` }}
          >
            {m.label === 1 ? '+' : '−'}
          </span>
        ))}
        {controller.encoding && (
          <div className="cutout-stage__loading" data-testid="cutout-loading">
            <Loader2 size={20} className="cutout-stage__spin" />
            AI 分析图片中…
          </div>
        )}
        {controller.segmenting && (
          <div className="cutout-stage__loading cutout-stage__loading--corner">
            <Loader2 size={14} className="cutout-stage__spin" />
          </div>
        )}
        {!controller.encoding && controller.points.length === 0 && !controller.error && (
          <div className="cutout-stage__hint">
            <Wand2 size={14} />
            移动鼠标自动预览目标,点击锁定;Alt+点击/右键加负点排除区域
          </div>
        )}
      </div>
    </div>
  );
};

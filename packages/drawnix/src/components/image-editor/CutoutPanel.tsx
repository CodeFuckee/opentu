/**
 * 抠图侧栏面板:工具切换、点管理、羽化、确认抠图。
 * 确认后经 onConfirm(dataURL) 走编辑器现有保存/插入链路。
 */
import React, { useState } from 'react';
import { MessagePlugin } from '../../utils/message-plugin';
import {
  Check,
  Eraser,
  MousePointerClick,
  Minus,
  RefreshCw,
  Undo2,
  Wand2,
} from 'lucide-react';
import type { CutoutController } from './cutout-controller';

interface CutoutPanelProps {
  controller: CutoutController;
  onConfirm: (dataUrl: string) => void;
}

export const CutoutPanel: React.FC<CutoutPanelProps> = ({ controller, onConfirm }) => {
  const [feather, setFeather] = useState(0);

  const handleConfirm = async () => {
    const dataUrl = await controller.confirm(feather);
    if (dataUrl) {
      onConfirm(dataUrl);
    } else {
      MessagePlugin.error(controller.error ?? '抠图失败,请重试');
    }
  };

  return (
    <div className="cutout-panel" data-testid="cutout-panel">
      <div className="cutout-panel__section">
        <div className="cutout-panel__title">
          <Wand2 size={14} />
          智能抠图
        </div>
        <p className="cutout-panel__desc">
          鼠标移到目标上即实时预览掩码,点击锁定;负点可排除误选区域,确认后得到透明底素材。
        </p>
      </div>

      <div className="cutout-panel__section">
        <div className="cutout-panel__label">画笔</div>
        <div className="cutout-panel__tools">
          <button
            type="button"
            className={`cutout-panel__tool ${controller.tool === 'add' ? 'active' : ''}`}
            onClick={() => controller.setTool('add')}
            data-testid="cutout-tool-add"
          >
            <MousePointerClick size={14} />
            正点
          </button>
          <button
            type="button"
            className={`cutout-panel__tool ${controller.tool === 'remove' ? 'active' : ''}`}
            onClick={() => controller.setTool('remove')}
            data-testid="cutout-tool-remove"
          >
            <Minus size={14} />
            负点
          </button>
        </div>
      </div>

      <div className="cutout-panel__section">
        <div className="cutout-panel__label">点 ({controller.points.length})</div>
        <div className="cutout-panel__tools">
          <button
            type="button"
            className="cutout-panel__tool"
            onClick={controller.undo}
            disabled={controller.points.length === 0}
          >
            <Undo2 size={14} />
            撤销
          </button>
          <button
            type="button"
            className="cutout-panel__tool"
            onClick={controller.clearPoints}
            disabled={controller.points.length === 0}
          >
            <Eraser size={14} />
            清空
          </button>
          <button type="button" className="cutout-panel__tool" onClick={controller.reencode}>
            <RefreshCw size={14} />
            重新分析
          </button>
        </div>
      </div>

      <div className="cutout-panel__section">
        <div className="cutout-panel__label">边缘羽化 {feather}px</div>
        <input
          type="range"
          min={0}
          max={3}
          step={1}
          value={feather}
          onChange={(e) => setFeather(Number(e.target.value))}
          className="cutout-panel__feather"
          data-testid="cutout-feather"
        />
      </div>

      <div className="cutout-panel__section">
        <button
          type="button"
          className="cutout-panel__confirm"
          onClick={handleConfirm}
          disabled={!controller.maskOverlayUrl || controller.composing || controller.encoding}
          data-testid="cutout-confirm"
        >
          <Check size={14} />
          {controller.composing ? '合成中…' : '确认抠图'}
        </button>
        {controller.session && (
          <div className="cutout-panel__meta">
            {controller.session.device.toUpperCase()} · 分析 {controller.session.encodeMs}ms
            {controller.score !== null && ` · 置信 ${(controller.score * 100).toFixed(0)}%`}
          </div>
        )}
        {controller.error && (
          <div className="cutout-panel__error" data-testid="cutout-error">
            {controller.error}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * HoverTip：统一悬浮提示（MD3 迁移，openspec adopt-material-design-3）
 *
 * 对外 API 与原 TDesign 版本保持兼容（content/placement/showArrow/delay/zIndex/
 * theme/disabled），内部实现替换为 MUI Tooltip——调用方零改动。
 */
import React from 'react';
import MuiTooltip, { TooltipProps as MuiTooltipProps } from '@mui/material/Tooltip';
import { Z_INDEX } from '../../../constants/z-index';
import { hasUsableHoverContent, stripNativeHoverProps } from './hover-utils';

const DEFAULT_TOOLTIP_DELAY = 300;

/** TDesign placement（'top-left' 连字符方位）→ MUI placement（'top-start'） */
function toMuiPlacement(
  placement?: string
): MuiTooltipProps['placement'] {
  if (!placement) return 'bottom';
  return placement.replace(/-left$/, '-start').replace(/-right$/, '-end') as MuiTooltipProps['placement'];
}

export type HoverTipProps = {
  children: React.ReactNode;
  content?: React.ReactNode;
  disabled?: boolean;
  /** 兼容保留：MD3 Tooltip 视觉由主题统一，不再区分 light/dark 变体 */
  theme?: 'light' | 'dark' | 'primary' | 'success' | 'warning' | 'danger';
  /** 悬浮触发延迟（ms） */
  delay?: number;
  zIndex?: number;
  showArrow?: boolean;
  placement?: string;
  className?: string;
  style?: React.CSSProperties;
  /** 兼容 TDesign 旧用法：浮层根类名（映射到 Popper className） */
  overlayClassName?: string;
  /** 兼容 TDesign 旧用法：浮层根样式（映射到 Popper style） */
  overlayStyle?: React.CSSProperties;
  /** 兼容 TDesign 旧用法：内容体内类名 */
  overlayInnerClassName?: string;
  /** 兼容 TDesign 旧用法：受控显隐（true=强制显示；onVisibleChange 在关闭时回调） */
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
};

export function HoverTip({
  children,
  content,
  disabled = false,
  delay = DEFAULT_TOOLTIP_DELAY,
  zIndex = Z_INDEX.TOOLTIP,
  showArrow = false,
  placement,
  className,
  style,
  overlayClassName,
  overlayStyle,
  overlayInnerClassName,
  visible,
  onVisibleChange,
}: HoverTipProps) {
  const child = stripNativeHoverProps(children) as React.ReactElement;

  if (disabled || !hasUsableHoverContent(content)) {
    return <>{child}</>;
  }

  // 受控显隐：TDesign 的 visible=true 表示常显（hover 之外仍展示）
  const controlledOpen = visible === true;

  // MUI 9 对「字符串 title」会给 child 注入 aria-label=title（覆盖按钮可见文本
  // 的可访问名，破坏按文本匹配的 E2E 选择器）——包成 element 走 aria-labelledby
  // 路线：非悬浮态可访问名保持 child 自身文本，悬浮态由 tooltip 提供
  const tooltipTitle: React.ReactNode =
    typeof content === 'string' ? <span>{content}</span> : content;

  return (
    <MuiTooltip
      title={tooltipTitle}
      placement={toMuiPlacement(placement)}
      arrow={showArrow}
      enterDelay={controlledOpen ? -1 : delay}
      enterNextDelay={delay}
      open={visible === undefined ? undefined : controlledOpen ? true : undefined}
      onClose={() => onVisibleChange?.(false)}
      disableHoverListener={controlledOpen}
      disableFocusListener={controlledOpen}
      disableTouchListener={controlledOpen}
      slotProps={{
        popper: {
          sx: { zIndex },
          className: className ?? overlayClassName,
          style: style ?? overlayStyle,
        },
        tooltip: {
          className: overlayInnerClassName,
        },
      }}
    >
      {child}
    </MuiTooltip>
  );
}

export default HoverTip;

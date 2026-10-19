// Credits to excalidraw
// MD3 迁移（adopt-material-design-3）：button/icon/submit 态内部实现替换为
// MUI IconButton（对外 props/className/testid/data-track/aria 全量透传，调用方
// 零改动）；radio 态保留原生 input[type=radio] 语义（E2E getByRole('radio') 与
// 键盘快捷键依赖），视觉由 tool-icon.scss 渐进对齐 MD3 令牌。
import './tool-icon.scss';

import type { CSSProperties } from 'react';
import React, { useEffect, useRef, useState } from 'react';
import IconButton from '@mui/material/IconButton';
import { PopupPlacement } from 'tdesign-react';
import { AbortError } from '../errors';
import { isPromiseLike } from '@aitu/utils';
import classNames from 'classnames';
import { EventPointerType } from '../types';
import { HoverTip } from './shared/hover';

export type ToolButtonSize = 'small' | 'medium';

type ToolButtonBaseProps = {
  icon?: React.ReactNode;
  'aria-label': string;
  'aria-keyshortcuts'?: string;
  'data-testid'?: string;
  'data-track'?: string;
  label?: string;
  /** @deprecated 优先使用 tooltip，避免与原生 title 语义混淆 */
  title?: string;
  tooltip?: React.ReactNode;
  /** Tooltip 显示位置，默认为 'bottom' */
  tooltipPlacement?: PopupPlacement;
  name?: string;
  id?: string;
  size?: ToolButtonSize;
  keyBindingLabel?: string | null;
  showAriaLabel?: boolean;
  hidden?: boolean;
  visible?: boolean;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  onPointerDown?(data: {
    pointerType: EventPointerType;
    event: React.PointerEvent<HTMLElement>;
  }): void;
  onPointerUp?(data: { pointerType: EventPointerType }): void;
};

type ToolButtonProps =
  | (ToolButtonBaseProps & {
      type: 'button';
      children?: React.ReactNode;
      onClick?(event: React.MouseEvent): void;
    })
  | (ToolButtonBaseProps & {
      type: 'submit';
      children?: React.ReactNode;
      onClick?(event: React.MouseEvent): void;
    })
  | (ToolButtonBaseProps & {
      type: 'icon';
      children?: React.ReactNode;
      onClick?(): void;
    })
  | (ToolButtonBaseProps & {
      type: 'radio';
      checked: boolean;
      onChange?(data: { pointerType: EventPointerType | null }): void;
    });

export const ToolButton = React.forwardRef((props: ToolButtonProps, ref) => {
  const { id: drawnixId } = { id: 'drawnix' };
  const innerRef = React.useRef(null);
  React.useImperativeHandle(ref, () => innerRef.current);
  const sizeCn = `tool-icon_size_${props.size || 'medium'}`;

  const [isLoading, setIsLoading] = useState(false);

  const isMountedRef = useRef(true);

  const onClick = async (event: React.MouseEvent) => {
    const ret = 'onClick' in props && props.onClick?.(event);

    if (isPromiseLike(ret)) {
      try {
        setIsLoading(true);
        await ret;
      } catch (error: any) {
        if (!(error instanceof AbortError)) {
          throw error;
        } else {
          console.warn(error);
        }
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
        }
      }
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const lastPointerTypeRef = useRef<EventPointerType | null>(null);
  const tooltipContent = props.tooltip ?? props.title;

  if (
    props.type === 'button' ||
    props.type === 'icon' ||
    props.type === 'submit'
  ) {
    const type = (props.type === 'icon' ? 'button' : props.type) as
      | 'button'
      | 'submit';

    // MD3：IconButton 提供涟漪/焦点态；存量 tool-icon 类继续主导尺寸与内嵌布局
    const buttonElement = (
      <IconButton
        component="button"
        type={type}
        className={classNames(
          'tool-icon_type_button',
          sizeCn,
          props.className,
          props.visible && !props.hidden
            ? 'tool-icon_type_button--show'
            : 'tool-icon_type_button--hide',
          {
            'tool-icon': !props.hidden,
            'tool-icon--selected': props.selected,
          }
        )}
        style={props.style}
        data-testid={props['data-testid']}
        data-track={props['data-track']}
        hidden={props.hidden}
        aria-label={props['aria-label']}
        aria-keyshortcuts={props['aria-keyshortcuts']}
        onClick={onClick}
        onPointerDown={(event) => {
          props.onPointerDown?.({
            pointerType: event.pointerType || null,
            event,
          });
        }}
        onPointerUp={(event) => {
          props.onPointerUp?.({ pointerType: event.pointerType || null });
        }}
        ref={innerRef as React.Ref<HTMLButtonElement>}
        disabled={isLoading || !!props.disabled}
        sx={{
          // 存量 tool-icon.scss 主导尺寸/圆角/背景，这里只关掉 MUI 默认占位
          padding: 0,
          width: 'auto',
          height: 'auto',
          borderRadius: 'inherit',
          '&:hover': { backgroundColor: 'transparent' },
        }}
      >
        {(props.icon || props.label) && (
          <div
            className="tool-icon__icon"
            aria-hidden="true"
            aria-disabled={!!props.disabled}
          >
            {props.icon || props.label}
            {props.keyBindingLabel && (
              <span className="tool-icon__keybinding">
                {props.keyBindingLabel}
              </span>
            )}
          </div>
        )}
        {props.showAriaLabel && (
          <div className="tool-icon__label">
            {String(props['aria-label'] ?? '').split(' — ')[0]}
          </div>
        )}
        {props.children && (
          <div className="tool-icon__icon">{props.children}</div>
        )}
      </IconButton>
    );

    if (tooltipContent) {
      return (
        <HoverTip
          content={tooltipContent}
          placement={props.tooltipPlacement || 'bottom'}
          showArrow={false}
        >
          {buttonElement}
        </HoverTip>
      );
    }

    return buttonElement;
  }

  const labelElement = (
    <label
      className={classNames('tool-icon', props.className)}
      data-track={props['data-track']}
      onPointerDown={(event) => {
        lastPointerTypeRef.current = event.pointerType || null;
        props.onPointerDown?.({
          pointerType: event.pointerType || null,
          event,
        });
      }}
      onPointerUp={(event) => {
        props.onPointerUp?.({ pointerType: event.pointerType || null });
        requestAnimationFrame(() => {
          lastPointerTypeRef.current = null;
        });
      }}
    >
      <input
        className={`tool-icon_type_radio ${sizeCn}`}
        type="radio"
        name={props.name}
        aria-label={props['aria-label']}
        aria-keyshortcuts={props['aria-keyshortcuts']}
        data-testid={props['data-testid']}
        id={`${drawnixId}-${props.id}`}
        onChange={() => {
          props.onChange?.({ pointerType: lastPointerTypeRef.current });
        }}
        checked={props.checked}
        ref={innerRef}
      />
      <div className="tool-icon__icon">
        {props.icon}
        {props.keyBindingLabel && (
          <span className="tool-icon__keybinding">{props.keyBindingLabel}</span>
        )}
      </div>
      {props.showAriaLabel && props['aria-label'] && (
        <div className="tool-icon__label">
          {String(props['aria-label']).split(' — ')[0]}
        </div>
      )}
    </label>
  );

  if (tooltipContent) {
    return (
      <HoverTip
        content={tooltipContent}
        placement={props.tooltipPlacement || 'bottom'}
        showArrow={false}
      >
        {labelElement}
      </HoverTip>
    );
  }

  return labelElement;
});

ToolButton.displayName = 'ToolButton';

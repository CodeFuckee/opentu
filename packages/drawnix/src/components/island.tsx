// Credits to excalidraw
// MD3 迁移（adopt-material-design-3）：容器替换为 MUI Paper（elevation 走 MD3），
// 保留 island 类名与 --padding 变量（存量 island.scss 继续主导内边距/圆角细节）。
import classNames from 'classnames';
import './island.scss';

import React from 'react';
import MuiPaper from '@mui/material/Paper';

type IslandProps = {
  children: React.ReactNode;
  padding?: number;
  className?: string | boolean;
  style?: object;
} & React.HTMLAttributes<HTMLDivElement>;

export const Island = React.forwardRef<HTMLDivElement, IslandProps>(
  ({ children, padding, className, style, ...restProps }, ref) => (
    <MuiPaper
      elevation={2}
      className={classNames('island', className)}
      style={{ '--padding': padding, ...style } as React.CSSProperties}
      ref={ref}
      {...restProps}
    >
      {children}
    </MuiPaper>
  )
);

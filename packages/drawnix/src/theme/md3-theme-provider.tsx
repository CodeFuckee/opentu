/**
 * MD3 主题 Provider（openspec adopt-material-design-3）
 *
 * 包裹 MUI ThemeProvider 并通过 GlobalStyles 把 MD3 令牌以 `--md3-*` CSS 变量
 * 注入 :root 与 .drawnix——存量 `--color-*` 变量保持原值（零视觉破坏），
 * 迁移中的组件消费 `--md3-*`。
 *
 * mode 默认 light；对接画布主题切换（board.theme.themeColorMode）时由调用方传入。
 */
import React, { useMemo } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import GlobalStyles from '@mui/material/GlobalStyles';
import { Md3MessageHost } from './md3-message';
import CssBaseline from '@mui/material/CssBaseline';
import {
  getMd3Theme,
  md3CssVariableStyle,
  type Md3Mode,
} from './md3-theme';

export interface Md3ThemeProviderProps {
  mode?: Md3Mode;
  children: React.ReactNode;
}

export function Md3ThemeProvider({
  mode = 'light',
  children,
}: Md3ThemeProviderProps): React.ReactElement {
  const theme = useMemo(() => getMd3Theme(mode), [mode]);
  const vars = useMemo(() => md3CssVariableStyle(mode), [mode]);

  const globalStyles = useMemo(
    () => (
      <GlobalStyles
        styles={{
          ':root': vars,
          '.drawnix': vars,
        }}
      />
    ),
    [vars]
  );

  return (
    <ThemeProvider theme={theme}>
      {globalStyles}
      <CssBaseline enableColorScheme />
      <Md3MessageHost />
      {children}
    </ThemeProvider>
  );
}

export default Md3ThemeProvider;

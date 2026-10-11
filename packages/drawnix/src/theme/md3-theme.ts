/**
 * Material Design 3 主题（openspec adopt-material-design-3）
 *
 * - 种子色 = 品牌橙 #F39C12，手工调校的 MD3 color roles（light/dark 双方案）
 * - createTheme 供 MUI 组件消费；typography/shape/elevation 按 MD3 规范
 * - 字体用系统栈（内网无 Google Fonts CDN）
 * - cssVariablesBridge：把 MD3 令牌以 `--md3-*` 变量暴露给迁移中的组件；
 *   存量 `--color-*` 变量保持原值（零视觉破坏），随组件迁移逐个收敛
 */

import { createTheme, Theme } from '@mui/material/styles';

export type Md3Mode = 'light' | 'dark';

/** 品牌锚点（与存量 --brand-primary 一致，迁移不换品牌色） */
export const BRAND_PRIMARY = '#F39C12';

interface Md3Scheme {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  tertiary: string;
  onTertiary: string;
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;
  surface: string;
  onSurface: string;
  surfaceVariant: string;
  onSurfaceVariant: string;
  surfaceContainerLowest: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;
  outline: string;
  outlineVariant: string;
  inverseSurface: string;
  inverseOnSurface: string;
  inversePrimary: string;
  scrim: string;
}

/** MD3 light scheme（种子 #F39C12，primary 取白字可读的深橙 #B45309） */
export const MD3_LIGHT: Md3Scheme = {
  primary: '#B45309',
  onPrimary: '#FFFFFF',
  primaryContainer: '#FEF5E7',
  onPrimaryContainer: '#5A3A10',
  secondary: '#74593F',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#FFDCC2',
  onSecondaryContainer: '#2B1707',
  tertiary: '#5D6237',
  onTertiary: '#FFFFFF',
  error: '#BA1A1A',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',
  surface: '#FFF8F5',
  onSurface: '#201B16',
  surfaceVariant: '#F2DFD1',
  onSurfaceVariant: '#504439',
  surfaceContainerLowest: '#FFFFFF',
  surfaceContainerLow: '#FFF1E8',
  surfaceContainer: '#FBEBDF',
  surfaceContainerHigh: '#F5E5D9',
  surfaceContainerHighest: '#F0DFD3',
  outline: '#827366',
  outlineVariant: '#D3C4B4',
  inverseSurface: '#362F29',
  inverseOnSurface: '#FBEBDF',
  inversePrimary: '#FFB86B',
  scrim: '#000000',
};

/** MD3 dark scheme（同一色种，反转明度） */
export const MD3_DARK: Md3Scheme = {
  primary: '#FFB86B',
  onPrimary: '#4A2800',
  primaryContainer: '#6A3D00',
  onPrimaryContainer: '#FFDCC2',
  secondary: '#E5C0A3',
  onSecondary: '#432B18',
  secondaryContainer: '#5C402B',
  onSecondaryContainer: '#FFDCC2',
  tertiary: '#C6CC9D',
  onTertiary: '#2E3300',
  error: '#FFB4AB',
  onError: '#690005',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6',
  surface: '#18120D',
  onSurface: '#EDE0D4',
  surfaceVariant: '#504439',
  onSurfaceVariant: '#F2DFD1',
  surfaceContainerLowest: '#120D08',
  surfaceContainerLow: '#201B16',
  surfaceContainer: '#241F19',
  surfaceContainerHigh: '#2F2923',
  surfaceContainerHighest: '#3A342D',
  outline: '#9B8E80',
  outlineVariant: '#504439',
  inverseSurface: '#EDE0D4',
  inverseOnSurface: '#362F29',
  inversePrimary: '#B45309',
  scrim: '#000000',
};

/** 系统字体栈（内网无 Google Fonts） */
const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

/** 由 scheme 构建 MUI 主题（palette/typography/shape/elevation 按 MD3） */
export function buildMd3Theme(mode: Md3Mode): Theme {
  const s = mode === 'light' ? MD3_LIGHT : MD3_DARK;
  return createTheme({
    palette: {
      mode,
      primary: {
        main: s.primary,
        contrastText: s.onPrimary,
        light: mode === 'light' ? '#D0762B' : '#FFD2A8',
        dark: mode === 'light' ? '#8A3F04' : '#C8894B',
      },
      secondary: {
        main: s.secondary,
        contrastText: s.onSecondary,
      },
      error: {
        main: s.error,
        contrastText: s.onError,
      },
      success: {
        main: mode === 'light' ? '#268029' : '#7FD985',
      },
      warning: {
        main: mode === 'light' ? '#B45309' : '#FFB86B',
      },
      background: {
        default: s.surface,
        paper: s.surfaceContainerLow,
      },
      text: {
        primary: s.onSurface,
        secondary: s.onSurfaceVariant,
        disabled: s.outline,
      },
      divider: s.outlineVariant,
      action: {
        hover: mode === 'light' ? 'rgba(32, 27, 22, 0.04)' : 'rgba(237, 224, 212, 0.06)',
        selected: mode === 'light' ? 'rgba(180, 83, 9, 0.08)' : 'rgba(255, 184, 107, 0.10)',
        disabledOpacity: 0.38,
      },
    },
    shape: {
      // MD3: 小组件 8dp，大容器 12~16dp（组件级再覆写）
      borderRadius: 8,
    },
    typography: {
      fontFamily: FONT_FAMILY,
      button: {
        textTransform: 'none',
        fontWeight: 500,
      },
      h1: { fontSize: '2.5rem', fontWeight: 400 },
      h2: { fontSize: '2rem', fontWeight: 400 },
      h3: { fontSize: '1.75rem', fontWeight: 400 },
      h4: { fontSize: '1.5rem', fontWeight: 400 },
      h5: { fontSize: '1.25rem', fontWeight: 400 },
      h6: { fontSize: '1.125rem', fontWeight: 500, lineHeight: 1.33 },
      subtitle1: { fontSize: '1rem', lineHeight: 1.5 },
      subtitle2: { fontSize: '0.875rem', fontWeight: 500, lineHeight: 1.43 },
      body1: { fontSize: '1rem', lineHeight: 1.5 },
      body2: { fontSize: '0.875rem', lineHeight: 1.43 },
      caption: { fontSize: '0.75rem', lineHeight: 1.33 },
      overline: { fontSize: '0.6875rem', fontWeight: 500, letterSpacing: '0.5px' },
    },
    shadows: [
      'none',
      // MD3 elevation level 1
      '0px 1px 2px rgba(0, 0, 0, 0.30), 0px 1px 3px 1px rgba(0, 0, 0, 0.15)',
      // level 2
      '0px 1px 2px rgba(0, 0, 0, 0.30), 0px 2px 6px 2px rgba(0, 0, 0, 0.15)',
      // level 3
      '0px 4px 8px 3px rgba(0, 0, 0, 0.15), 0px 1px 3px rgba(0, 0, 0, 0.30)',
      // level 4
      '0px 6px 10px 4px rgba(0, 0, 0, 0.15), 0px 2px 3px rgba(0, 0, 0, 0.30)',
      // level 5
      '0px 8px 12px 6px rgba(0, 0, 0, 0.15), 0px 4px 4px rgba(0, 0, 0, 0.30)',
      ...Array(19).fill(
        '0px 8px 12px 6px rgba(0, 0, 0, 0.15), 0px 4px 4px rgba(0, 0, 0, 0.30)'
      ),
    ] as Theme['shadows'],
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 100 },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
        },
      },
      MuiTooltip: {
        defaultProps: { enterDelay: 400 },
      },
    },
  });
}

/** 主题缓存，避免每次渲染重建 */
const themeCache = new Map<Md3Mode, Theme>();

export function getMd3Theme(mode: Md3Mode): Theme {
  let theme = themeCache.get(mode);
  if (!theme) {
    theme = buildMd3Theme(mode);
    themeCache.set(mode, theme);
  }
  return theme;
}

/** MD3 令牌 → `--md3-*` CSS 变量（供迁移中的组件消费，存量 --color-* 不动） */
export function md3CssVariableStyle(mode: Md3Mode): Record<string, string> {
  const s = mode === 'light' ? MD3_LIGHT : MD3_DARK;
  return {
    '--md3-primary': s.primary,
    '--md3-on-primary': s.onPrimary,
    '--md3-primary-container': s.primaryContainer,
    '--md3-on-primary-container': s.onPrimaryContainer,
    '--md3-secondary': s.secondary,
    '--md3-on-secondary': s.onSecondary,
    '--md3-secondary-container': s.secondaryContainer,
    '--md3-on-secondary-container': s.onSecondaryContainer,
    '--md3-tertiary': s.tertiary,
    '--md3-error': s.error,
    '--md3-on-error': s.onError,
    '--md3-error-container': s.errorContainer,
    '--md3-surface': s.surface,
    '--md3-on-surface': s.onSurface,
    '--md3-surface-variant': s.surfaceVariant,
    '--md3-on-surface-variant': s.onSurfaceVariant,
    '--md3-surface-container-lowest': s.surfaceContainerLowest,
    '--md3-surface-container-low': s.surfaceContainerLow,
    '--md3-surface-container': s.surfaceContainer,
    '--md3-surface-container-high': s.surfaceContainerHigh,
    '--md3-surface-container-highest': s.surfaceContainerHighest,
    '--md3-outline': s.outline,
    '--md3-outline-variant': s.outlineVariant,
    '--md3-brand': BRAND_PRIMARY,
    '--md3-font-family': FONT_FAMILY,
  };
}

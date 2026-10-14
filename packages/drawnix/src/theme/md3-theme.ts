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

/**
 * MD3 令牌 → CSS 变量。
 *
 * 两组输出：
 * 1. `--md3-*`：迁移组件直接消费的规范令牌；
 * 2. 存量 `--color-*` / 壳层变量回写——组件底座 MUI 化后，把高频存量变量切到
 *    MD3 值，让菜单/工具栏/抽屉/弹窗等既有界面整体获得 MD3 配色（含暗色）。
 *    品牌锚点 --brand-primary 保持 #F39C12 不变。
 */
export function md3CssVariableStyle(mode: Md3Mode): Record<string, string> {
  const s = mode === 'light' ? MD3_LIGHT : MD3_DARK;
  const legacy = {
    // 表面梯度
    '--island-bg-color': s.surfaceContainerLow,
    '--island-border-color': s.outlineVariant,
    '--dialog-border-color': s.outlineVariant,
    '--color-surface-lowest': s.surfaceContainerLowest,
    '--color-surface-low': s.surfaceContainerLow,
    '--color-surface-mid': s.surfaceContainer,
    '--color-surface-high': s.surfaceContainerHigh,
    '--color-on-surface': s.onSurface,
    '--text-primary-color': s.onSurface,
    '--color-surface-primary-container': s.primaryContainer,
    '--color-on-primary-container': s.onPrimaryContainer,
    '--color-border-outline': s.outline,
    '--color-border-outline-variant': s.outlineVariant,
    '--button-hover-bg': s.surfaceContainerHigh,
    '--button-active-bg': s.surfaceContainerHigh,
    '--button-active-border': s.primary,
    '--default-border-color': s.outlineVariant,
    '--focus-highlight-color': s.primary,
    '--link-color': s.primary,
    '--shadow-island': 'var(--md3-elevation-2)',
    // 品牌锚点不动（存量渐变/品牌装饰继续引用）
    '--brand-primary': BRAND_PRIMARY,
    '--color-primary': BRAND_PRIMARY,
    '--color-primary-hover': mode === 'light' ? '#E67E22' : '#FFB86B',
    '--color-brand-hover': mode === 'light' ? '#E67E22' : '#FFB86B',
    '--aitu-ui-surface': s.surfaceContainerLow,
    '--aitu-ui-surface-elevated': s.surfaceContainerLow,
    '--aitu-ui-surface-subtle': s.surfaceContainer,
    '--aitu-ui-surface-muted': s.surfaceContainerHigh,
    '--aitu-ui-text-primary': s.onSurface,
    '--aitu-ui-text-secondary': s.onSurfaceVariant,
    '--aitu-ui-text-tertiary': s.outline,
    '--aitu-ui-border': s.outlineVariant,
    '--aitu-ui-border-subtle': s.outlineVariant,
    '--aitu-ui-hover-bg': s.surfaceContainerHigh,
    '--aitu-ui-brand-text': s.primary,
  };
  return {
    ...legacy,
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
    '--md3-elevation-1':
      '0px 1px 2px rgba(0, 0, 0, 0.30), 0px 1px 3px 1px rgba(0, 0, 0, 0.15)',
    '--md3-elevation-2':
      '0px 1px 2px rgba(0, 0, 0, 0.30), 0px 2px 6px 2px rgba(0, 0, 0, 0.15)',
    '--md3-elevation-3':
      '0px 4px 8px 3px rgba(0, 0, 0, 0.15), 0px 1px 3px rgba(0, 0, 0, 0.30)',
    '--md3-brand': BRAND_PRIMARY,
    '--md3-font-family': FONT_FAMILY,

    // ----------------------------------------------------------------
    // TDesign → MD3 令牌桥（adopt-material-design-3 批次深化）：
    // 把 TDesign 组件消费的 --td-* 令牌映射到 MD3 scheme，使全部存量
    // TDesign 组件（81 文件）随 MD3 主题呈现，DOM 结构与选择器零破坏。
    // 深替换（组件换 MUI 原生）按 openspec 批次继续，此处只做令牌层统一。
    // ----------------------------------------------------------------
    // 品牌族
    '--td-brand-color': s.primary,
    '--td-brand-color-1': s.primaryContainer,
    '--td-brand-color-2': mode === 'light' ? '#F2C48D' : '#7A5A33',
    '--td-brand-color-3': mode === 'light' ? '#E6A85C' : '#8A6537',
    '--td-brand-color-4': mode === 'light' ? '#DE9440' : '#96703C',
    '--td-brand-color-5': '#D9822B',
    '--td-brand-color-6': BRAND_PRIMARY,
    '--td-brand-color-7': mode === 'light' ? '#B45309' : '#FFB86B',
    '--td-brand-color-8': mode === 'light' ? '#A34A08' : '#FFC98F',
    '--td-brand-color-9': mode === 'light' ? '#8A3F04' : '#FFD9B3',
    '--td-brand-color-10': mode === 'light' ? '#6E3303' : '#FFE7CC',
    '--td-brand-color-focus': s.primary,
    '--td-brand-color-hover': mode === 'light' ? '#E67E22' : '#FFB86B',
    '--td-brand-color-active': mode === 'light' ? '#B45309' : '#FFC98F',
    '--td-brand-color-disabled': mode === 'light' ? '#F2C48D' : '#7A5A33',
    '--td-brand-color-light': s.primaryContainer,
    '--td-brand-color-light-selected': s.primaryContainer,
    '--td-brand-color-hover-dark': mode === 'light' ? '#E67E22' : '#FFB86B',
    // 成功/警告/错误族（success/warning 与 MUI palette 同源）
    '--td-success-color': mode === 'light' ? '#268029' : '#7FD985',
    '--td-success-color-focus': mode === 'light' ? '#1E6A21' : '#98E2A0',
    '--td-success-color-hover': mode === 'light' ? '#217424' : '#8FDC96',
    '--td-success-color-active': mode === 'light' ? '#1E6A21' : '#98E2A0',
    '--td-success-color-disabled': mode === 'light' ? '#A9D2AB' : '#3F5C42',
    '--td-success-color-light': mode === 'light' ? '#E3F1E4' : '#22352a',
    '--td-warning-color': mode === 'light' ? '#B45309' : '#FFB86B',
    '--td-warning-color-focus': mode === 'light' ? '#9A4708' : '#FFC98F',
    '--td-warning-color-hover': mode === 'light' ? '#A84E08' : '#FFC280',
    '--td-warning-color-active': mode === 'light' ? '#9A4708' : '#FFC98F',
    '--td-warning-color-disabled': mode === 'light' ? '#E2C0A0' : '#5C4A33',
    '--td-warning-color-light': mode === 'light' ? '#FBF0E4' : '#3a2f1e',
    '--td-error-color': s.error,
    '--td-error-color-focus': s.onErrorContainer,
    '--td-error-color-hover': mode === 'light' ? '#B3261E' : '#F2B8B5',
    '--td-error-color-active': s.onErrorContainer,
    '--td-error-color-disabled': mode === 'light' ? '#E6C8C7' : '#5C4443',
    '--td-error-color-light': s.errorContainer,
    // 文字族
    '--td-text-color-primary': s.onSurface,
    '--td-text-color-secondary': s.onSurfaceVariant,
    '--td-text-color-placeholder': s.outline,
    '--td-text-color-disabled': s.outline,
    '--td-text-color-anti': s.surface,
    '--td-text-color-brand': s.primary,
    '--td-text-color-opposite': s.surface,
    // 背景与组件面
    '--td-bg-color-page': s.surface,
    '--td-bg-color-container': s.surfaceContainerLow,
    '--td-bg-color-container-secondary': s.surfaceContainer,
    '--td-bg-color-secondarycontainer': s.surfaceContainer,
    '--td-bg-color-secondary-container': s.surfaceContainer,
    '--td-bg-color-component': s.surfaceContainerHigh,
    '--td-bg-color-secondary-component': s.surfaceContainerHighest,
    '--td-component-border': s.outlineVariant,
    '--td-component-stroke': s.outlineVariant,
    '--td-component-disabled': s.surfaceContainerHighest,
    // 灰阶（TDesign 组件内部大量消费；按明暗各自贴合 surface/outline）
    '--td-gray-1': s.surfaceContainerLowest,
    '--td-gray-2': s.surfaceContainerLow,
    '--td-gray-3': s.surfaceContainer,
    '--td-gray-4': s.surfaceContainerHigh,
    '--td-gray-5': mode === 'light' ? '#C5C6C8' : '#4A4B4D',
    '--td-gray-6': mode === 'light' ? '#A6A9AC' : '#5C5E60',
    '--td-gray-7': mode === 'light' ? '#8C9093' : '#6E7072',
    '--td-gray-8': mode === 'light' ? '#6B6F73' : '#84868A',
    '--td-gray-9': mode === 'light' ? '#4B4F52' : '#9C9EA2',
    '--td-gray-10': mode === 'light' ? '#383A3D' : '#B4B6BA',
    '--td-gray-11': mode === 'light' ? '#2C2E30' : '#CDD0D3',
    '--td-gray-12': mode === 'light' ? '#1F2124' : '#E3E5E8',
    '--td-gray-13': mode === 'light' ? '#141518' : '#F0F2F4',
    '--td-gray-14': mode === 'light' ? '#0A0B0D' : '#F7F8FA',
    // 圆角/字体（与 MD3 shape/typography 对齐）
    '--td-radius-small': '4px',
    '--td-radius-medium': '8px',
    '--td-radius-large': '12px',
    '--td-radius-extraLarge': '20px',
    '--td-radius-round': '999px',
    '--td-radius-circle': '50%',
    '--td-font-family': FONT_FAMILY,
  };
}

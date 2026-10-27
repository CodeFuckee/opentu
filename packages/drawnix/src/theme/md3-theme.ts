/**
 * Material Design 3 主题（openspec adopt-material-design-3）
 *
 * - 配色 = M3 官方蓝（2026-10-19 用户确立，Google Workspace 同款）：
 *   primary #0B57D0 / #A8C7FA，中性色取 Google 灰阶。
 *   语义色（error/success/warning）保留各自色相。
 * - createTheme 供 MUI 组件消费；typography/shape/elevation 按 MD3 规范
 * - 字体用系统栈（内网无 Google Fonts CDN）
 * - cssVariablesBridge：把 MD3 令牌以 `--md3-*` 变量暴露给迁移中的组件；
 *   存量 `--color-*` 变量保持原值（零视觉破坏），随组件迁移逐个收敛
 */

import { createTheme, Theme } from '@mui/material/styles';

export type Md3Mode = 'light' | 'dark';

/** 品牌锚点（与存量 --brand-primary 一致，迁移不换品牌锚点机制） */
export const BRAND_PRIMARY = '#0B57D0';

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

/** MD3 light scheme（官方 M3 蓝：primary #0B57D0；中性轴 = 暖纸灰阶，
 * 与画布 #F3F0E9 暖纸底同族——参照专业画布工具的纸感中性色，冷灰显闷） */
export const MD3_LIGHT: Md3Scheme = {
  primary: '#0B57D0',
  onPrimary: '#FFFFFF',
  primaryContainer: '#D3E3FD',
  onPrimaryContainer: '#041E49',
  secondary: '#5F5B52',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#ECE8DF',
  onSecondaryContainer: '#1C1B17',
  tertiary: '#45518E',
  onTertiary: '#FFFFFF',
  error: '#BA1A1A',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',
  surface: '#FBFAF7',
  onSurface: '#1D1B18',
  surfaceVariant: '#ECE8E0',
  onSurfaceVariant: '#57534E',
  surfaceContainerLowest: '#FFFFFF',
  surfaceContainerLow: '#F6F4EF',
  surfaceContainer: '#F0EDE6',
  surfaceContainerHigh: '#FAF9F6',
  surfaceContainerHighest: '#F5F3EE',
  outline: '#79746C',
  outlineVariant: '#D8D3C8',
  inverseSurface: '#2E2C29',
  inverseOnSurface: '#F4F2ED',
  inversePrimary: '#D3E3FD',
  scrim: '#000000',
};

/** MD3 dark scheme（Google 灰阶：primary #A8C7FA；中性轴 = 暖炭黑，与画布 #161513 同族） */
export const MD3_DARK: Md3Scheme = {
  primary: '#A8C7FA',
  onPrimary: '#062E6F',
  primaryContainer: '#0842A0',
  onPrimaryContainer: '#D3E3FD',
  secondary: '#C7C3BA',
  onSecondary: '#201E1A',
  secondaryContainer: '#3A372F',
  onSecondaryContainer: '#E5E2DC',
  tertiary: '#B5C4F2',
  onTertiary: '#1A2C55',
  error: '#FFB4AB',
  onError: '#690005',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6',
  surface: '#161513',
  onSurface: '#E5E2DC',
  surfaceVariant: '#45423B',
  onSurfaceVariant: '#C9C4BA',
  surfaceContainerLowest: '#100F0E',
  surfaceContainerLow: '#1D1B19',
  surfaceContainer: '#22201D',
  surfaceContainerHigh: '#292723',
  surfaceContainerHighest: '#302D28',
  outline: '#948F85',
  outlineVariant: '#45423C',
  inverseSurface: '#E5E2DC',
  inverseOnSurface: '#2E2C29',
  inversePrimary: '#0B57D0',
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
        // M3 baseline primary：驱动 MUI 控件激活态与 contained 按钮
        main: s.primary,
        contrastText: s.onPrimary,
        light: mode === 'light' ? '#4C8DF6' : '#D3E3FD',
        dark: mode === 'light' ? '#093E99' : '#7BAAF7',
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
        hover: mode === 'light' ? 'rgba(0, 0, 0, 0.04)' : 'rgba(227, 227, 229, 0.06)',
        selected: mode === 'light' ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.10)',
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
      // MD3 shape：大容器 28dp（Dialog），菜单 16dp，卡片/提示 12dp
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 28,
            border: '1px solid var(--md3-hairline, rgba(0, 0, 0, 0.1))',
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            borderRadius: 16,
            border: '1px solid var(--md3-hairline, rgba(0, 0, 0, 0.1))',
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: { borderRadius: 12 },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 12 },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: { borderRadius: 999 },
        },
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
    // 品牌锚点：蓝主色；暗色下用浅蓝保证可读（存量装饰/文字引用随明暗取值）
    '--brand-primary': mode === 'light' ? BRAND_PRIMARY : '#A8C7FA',
    '--color-primary': mode === 'light' ? BRAND_PRIMARY : '#A8C7FA',
    '--color-primary-hover': mode === 'light' ? '#1A73E8' : '#D3E3FD',
    '--color-brand-hover': mode === 'light' ? '#1A73E8' : '#D3E3FD',
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
    // MD3 shape 回写：存量 SCSS 消费的 --border-radius-* 升到 MD3 shape scale
    //（sm 4→8 / md 6→12 / lg 8→16 / xl→28），圆角语言全局统一
    '--border-radius-sm': '8px',
    '--border-radius-md': '12px',
    '--border-radius-lg': '16px',
    '--border-radius-xl': '28px',
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
    '--md3-brand': mode === 'light' ? BRAND_PRIMARY : '#A8C7FA',
    '--md3-font-family': FONT_FAMILY,
    // MD3 shape scale：xs 4 / sm 8 / md 12 / lg 16 / xl 28 / full 圆
    '--md3-radius-xs': '4px',
    '--md3-radius-sm': '8px',
    '--md3-radius-md': '12px',
    '--md3-radius-lg': '16px',
    '--md3-radius-xl': '28px',
    '--md3-radius-full': '999px',
    // 遮罩 scrim（弹窗/loading 蒙层）
    '--md3-scrim': 'rgba(0, 0, 0, 0.5)',
    // 语义补充色（迁移组件消费；success 与 td-success 同源）
    '--md3-accent': s.primary,
    '--md3-on-accent': s.onPrimary,
    '--md3-accent-soft': mode === 'light' ? 'rgba(11, 87, 208, 0.10)' : 'rgba(168, 199, 250, 0.16)',
    '--md3-success': mode === 'light' ? '#268029' : '#7FD985',
    // 发丝分隔线（黑白系的悬浮物描边；暖黑基色呼应暖纸中性轴）
    '--md3-hairline': mode === 'light' ? 'rgba(56, 50, 42, 0.11)' : 'rgba(255, 255, 255, 0.13)',
    // 面板表面（工具栏/island 等悬浮面板专属，暖纸模式下与画布 #F3F0E9 拉开）
    '--md3-surface-panel': mode === 'light' ? '#FDFCF9' : '#22201D',
    // 悬浮坞令牌（画布上的工具条/缩放器/输入卡共用）：暖白半透玻璃 + 暖发丝
    // 描边 + 大而软的双层阴影，让浮层「落」在画布上而非「贴」在画布上
    '--md3-dock-bg':
      mode === 'light' ? 'rgba(252, 251, 248, 0.94)' : 'rgba(30, 28, 25, 0.92)',
    '--md3-dock-border':
      mode === 'light' ? 'rgba(93, 86, 76, 0.16)' : 'rgba(245, 245, 244, 0.10)',
    '--md3-dock-shadow':
      mode === 'light'
        ? '0 12px 36px rgba(43, 38, 32, 0.14), 0 2px 8px rgba(43, 38, 32, 0.07)'
        : '0 12px 36px rgba(0, 0, 0, 0.44), 0 2px 8px rgba(0, 0, 0, 0.28)',
    // 排版字阶（MD3 type scale 收敛版）：复合 font 简写，消费方 font: var(...)
    '--md3-text-title-lg': `600 17px/1.4 ${FONT_FAMILY}`,
    '--md3-text-title': `600 15px/1.45 ${FONT_FAMILY}`,
    '--md3-text-body': `400 14px/1.5 ${FONT_FAMILY}`,
    '--md3-text-secondary': `400 13px/1.5 ${FONT_FAMILY}`,
    '--md3-text-caption': `400 12px/1.45 ${FONT_FAMILY}`,
    '--md3-text-label': `500 11px/1.3 ${FONT_FAMILY}`,
    // 动效（M3 emphasized ease）
    '--md3-ease': 'cubic-bezier(0.2, 0, 0, 1)',
    '--md3-dur-fast': '120ms',
    '--md3-dur': '200ms',
    '--md3-dur-slow': '280ms',
    '--md3-inverse-surface': s.inverseSurface,
    '--md3-inverse-on-surface': s.inverseOnSurface,
    '--md3-inverse-primary': s.inversePrimary,
    // 焦点环（box-shadow 值，消费方均为 box-shadow: var(--md3-focus-ring, …)）
    '--md3-focus-ring':
      mode === 'light'
        ? '0 0 0 3px rgba(37, 99, 235, 0.16)'
        : '0 0 0 3px rgba(138, 180, 248, 0.25)',

    // ----------------------------------------------------------------
    // TDesign → MD3 令牌桥（adopt-material-design-3 批次深化）：
    // 把 TDesign 组件消费的 --td-* 令牌映射到 MD3 scheme，使全部存量
    // TDesign 组件（81 文件）随 MD3 主题呈现，DOM 结构与选择器零破坏。
    // 深替换（组件换 MUI 原生）按 openspec 批次继续，此处只做令牌层统一。
    // ----------------------------------------------------------------
    // 品牌族 = 唯一强调色族（蓝 accent，驱动 TDesign 开关/复选/激活态）
    '--td-brand-color': s.primary,
    '--td-brand-color-1': s.primaryContainer,
    '--td-brand-color-2': mode === 'light' ? '#A8C7FA' : '#2B4869',
    '--td-brand-color-3': mode === 'light' ? '#7BAAF7' : '#355F8C',
    '--td-brand-color-4': mode === 'light' ? '#4C8DF6' : '#4173A8',
    '--td-brand-color-5': '#1A73E8',
    '--td-brand-color-6': mode === 'light' ? BRAND_PRIMARY : '#669DF6',
    '--td-brand-color-7': mode === 'light' ? '#0A4CB3' : '#A8C7FA',
    '--td-brand-color-8': mode === 'light' ? '#093E99' : '#C3DDFC',
    '--td-brand-color-9': mode === 'light' ? '#083180' : '#D2E3FC',
    '--td-brand-color-10': mode === 'light' ? '#062E6F' : '#E8F0FE',
    '--td-brand-color-focus': s.primary,
    '--td-brand-color-hover': mode === 'light' ? '#1A73E8' : '#C3DDFC',
    '--td-brand-color-active': mode === 'light' ? '#0A4CB3' : '#A8C7FA',
    '--td-brand-color-disabled': mode === 'light' ? '#A8C7FA' : '#4173A8',
    '--td-brand-color-light': s.primaryContainer,
    '--td-brand-color-light-selected': s.primaryContainer,
    '--td-brand-color-hover-dark': mode === 'light' ? '#1A73E8' : '#C3DDFC',
    // 成功/警告/错误族（success/warning 与 MUI palette 同源；warning 保持琥珀语义色）
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

/**
 * @google/model-viewer web component 的 JSX 类型声明(React 18)。
 * 只声明本功能用到的属性;事件统一 ref + addEventListener 原生监听,
 * 不走 JSX 合成事件(web component 的 CustomEvent 不被 React 可靠代理)。
 *
 * 注意需同时增强 'react' 与 'react/jsx-runtime' 两个 JSX 命名空间:
 * 各项目 tsconfig 的 jsx 转换不同(preserve / react-jsx),二者解析到不同的
 * JSX.IntrinsicElements,只增强其一会在另一个项目的 typecheck 下报错。
 */
/* eslint-disable @typescript-eslint/no-namespace -- 模块增强的 JSX.IntrinsicElements 只能用 namespace 语法 */
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type ModelViewerAttributes = DetailedHTMLProps<
  HTMLAttributes<HTMLElement>,
  HTMLElement
> & {
  src?: string;
  alt?: string;
  'camera-controls'?: boolean | string;
  'auto-rotate'?: boolean | string;
  loading?: 'auto' | 'lazy' | 'eager';
  reveal?: 'auto' | 'manual' | 'interaction';
  'touch-action'?: string;
  'environment-image'?: string;
  'shadow-intensity'?: string;
  poster?: string;
};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': ModelViewerAttributes;
    }
  }
}

declare module 'react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': ModelViewerAttributes;
    }
  }
}

// 空导出使其成为模块:增强文件必须被 import 才会进入各项目 tsconfig 的编译程序
// (web 项目只 include 自己的 src,drawnix 文件经 import 图入program)
export {};

import { useState, useEffect, useDeferredValue } from 'react';
import './mermaid-to-drawnix.scss';
import './ttd-dialog.scss';
import { TTDDialogPanels } from './ttd-dialog-panels';
import { TTDDialogPanel } from './ttd-dialog-panel';
import { TTDDialogInput } from './ttd-dialog-input';
import { TTDDialogOutput } from './ttd-dialog-output';
import { TTDDialogSubmitShortcut } from './ttd-dialog-submit-shortcut';
import { useDrawnix, DialogType } from '../../hooks/use-drawnix';
import { useI18n } from '../../i18n';
import { useBoard } from '@plait-board/react-board';
import {
  getViewportOrigination,
  PlaitBoard,
  PlaitElement,
  Point,
  WritableClipboardOperationType,
} from '@plait/core';
import { MindElement } from '@plait/mind';
import { getSmartInsertionPoint, scrollToPointIfNeeded } from '../../utils/selection-utils';

export interface MarkdownToDrawnixLibProps {
  loaded: boolean;
  api: Promise<{
    parseMarkdownToDrawnix: (
      definition: string,
      mainTopic?: string
    ) => MindElement;
  }>;
}

const getMarkdownExample = (language: 'zh' | 'en') => {
  if (language === 'zh') {
    return `# Milkdown 入门

Milkdown 是一个强大的所见即所得 Markdown 编辑器，兼具 Markdown 的简洁和现代编辑器的灵活性。它轻量且可扩展，适合从简单到复杂的编辑需求。

## 快速开始
最快的方式是使用 @milkdown/crepe。

## 核心概念
Milkdown 由两部分组成：
1. 核心包（@milkdown/core）
   - 插件加载器
   - 内置插件
2. 扩展插件
   - 语法支持
   - 命令
   - UI 组件
   - 自定义能力

## 关键特性
- 📝 所见即所得 Markdown
- 🎨 可主题化
- 🎮 可扩展
- ⚡ Slash 与 Tooltip
- 🧮 LaTeX 数学公式
- 📊 表格
- 🍻 协作（yjs）
- 💾 剪贴板
- 👍 Emoji

## 技术栈
- Prosemirror
- Remark
- TypeScript

## 创建你的第一个编辑器
Milkdown 提供两种方式：

### 🍼 使用 @milkdown/kit（从零构建）
适合需要完全控制、自由组合功能的场景。

### 🥞 使用 @milkdown/crepe（开箱即用）
适合快速落地、开箱即用的生产环境。

## 下一步
🍼 有趣的事实：这个文档也是由 Milkdown 渲染的！`;
  } else {
    return `# Getting Started with Milkdown

Milkdown is a powerful WYSIWYG markdown editor that combines the simplicity of markdown with the flexibility of a modern editor. It's designed to be lightweight yet extensible, making it perfect for both simple and complex editing needs.

## Quick Start
The fastest way to get started is using @milkdown/crepe.

## Core Concepts
Milkdown consists of two main parts:
1. Core Package (@milkdown/core)
   - Plugin loader
   - Internal plugins
2. Additional Plugins
   - Syntax support
   - Commands
   - UI components
   - Custom features

## Key Features
- 📝 WYSIWYG Markdown
- 🎨 Themable
- 🎮 Hackable
- ⚡ Slash & Tooltip
- 🧮 Math (LaTeX)
- 📊 Table
- 🍻 Collaborate (yjs)
- 💾 Clipboard
- 👍 Emoji

## Tech Stack
- Prosemirror
- Remark
- TypeScript

## Creating Your First Editor
Milkdown provides two distinct approaches to create an editor:

### 🍼 Using @milkdown/kit (Build from Scratch)
Use this if you want full control and a custom editor from the ground up.

### 🥞 Using @milkdown/crepe (Ready to Use)
Use this if you want a production-ready editor with minimal setup.

## Next Steps
🍼 Fun fact: This documentation is rendered by Milkdown itself!`;
  }
};


const MarkdownToDrawnix = () => {
  const { appState, setAppState, closeDialog } = useDrawnix();
  const { t, language } = useI18n();
  const [markdownToDrawnixLib, setMarkdownToDrawnixLib] =
    useState<MarkdownToDrawnixLibProps>({
      loaded: false,
      api: Promise.resolve({
        parseMarkdownToDrawnix: (definition: string, mainTopic?: string) =>
          null as any as MindElement,
      }),
    });

  useEffect(() => {
    const loadLib = async () => {
      try {
        const module = await import('@plait-board/markdown-to-drawnix');
        setMarkdownToDrawnixLib({
          loaded: true,
          api: Promise.resolve(module),
        });
      } catch (err) {
        console.error('Failed to load markdown library:', err);
        setError(new Error(t('dialog.error.loadMermaid')));
      }
    };
    loadLib();
  }, []);
  const [text, setText] = useState(() => getMarkdownExample(language));
  const [value, setValue] = useState<PlaitElement[]>(() => []);
  const deferredText = useDeferredValue(text.trim());
  const [error, setError] = useState<Error | null>(null);
  const board = useBoard();

  // Update markdown example when language changes
  useEffect(() => {
    setText(getMarkdownExample(language));
  }, [language]);

  useEffect(() => {
    const convertMarkdown = async () => {
      try {
        const api = await markdownToDrawnixLib.api;
        let ret;
        try {
          ret = await api.parseMarkdownToDrawnix(deferredText);
        } catch (err: any) {
          ret = await api.parseMarkdownToDrawnix(
            deferredText.replace(/"/g, "'")
          );
        }
        const mind = ret;
        mind.points = [[0, 0]];
        if (mind) {
          setValue([mind]);
          setError(null);
        }
      } catch (err: any) {
        setError(err);
      }
    };
    convertMarkdown();
  }, [deferredText, markdownToDrawnixLib]);

  const insertToBoard = () => {
    if (!value.length) {
      return;
    }
    // Calculate insertion point - use selected elements position if available, otherwise default position
    let insertionPoint;
    const smartPoint = getSmartInsertionPoint(board);
    
    if (smartPoint) {
      insertionPoint = smartPoint;
    } else {
      // Default behavior when no elements are selected
      const boardContainerRect =
        PlaitBoard.getBoardContainer(board).getBoundingClientRect();
      const focusPoint = [
        boardContainerRect.width / 4,
        boardContainerRect.height / 2 - 20,
      ];
      const zoom = board.viewport.zoom;
      const origination = getViewportOrigination(board);
      const focusX = (origination?.[0] ?? 0) + focusPoint[0] / zoom;
      const focusY = (origination?.[1] ?? 0) + focusPoint[1] / zoom;
      insertionPoint = [focusX, focusY] as Point;
    }
    
    const elements = value;
    board.insertFragment(
      {
        elements: JSON.parse(JSON.stringify(elements)),
      },
      insertionPoint,
      WritableClipboardOperationType.paste
    );

    // 插入后滚动视口到新元素位置（如果不在视口内）
    if (insertionPoint) {
      requestAnimationFrame(() => {
        scrollToPointIfNeeded(board, insertionPoint);
      });
    }

    closeDialog(DialogType.markdownToDrawnix);
  };

  return (
    <>
      <div className="ttd-dialog-desc">
        {t('dialog.markdown.description')}
      </div>
      <TTDDialogPanels>
        <TTDDialogPanel label={t('dialog.markdown.syntax')}>
          <TTDDialogInput
            input={text}
            placeholder={t('dialog.markdown.placeholder')}
            onChange={(event) => setText(event.target.value)}
            onKeyboardSubmit={() => {
              insertToBoard();
            }}
          />
        </TTDDialogPanel>
        <TTDDialogPanel
          label={t('dialog.markdown.preview')}
          panelAction={{
            action: () => {
              insertToBoard();
            },
            label: t('dialog.markdown.insert'),
          }}
          renderSubmitShortcut={() => <TTDDialogSubmitShortcut />}
        >
          <TTDDialogOutput
            value={value}
            loaded={markdownToDrawnixLib.loaded}
            error={error}
          />
        </TTDDialogPanel>
      </TTDDialogPanels>
    </>
  );
};
export default MarkdownToDrawnix;

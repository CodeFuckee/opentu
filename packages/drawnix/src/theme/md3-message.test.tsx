// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Md3MessageHost,
  showMd3Message,
  _resetMd3MessagesForTests,
} from './md3-message';
import { MessagePlugin } from '../utils/message-plugin';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('Md3MessageHost / MessagePlugin', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
    _resetMd3MessagesForTests();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('MessagePlugin.success 经宿主渲染 MUI Alert 文本', () => {
    act(() => {
      root.render(<Md3MessageHost />);
    });
    act(() => {
      MessagePlugin.success('保存成功');
    });
    expect(container.querySelector('.MuiAlert-root')).not.toBeNull();
    expect(container.querySelector('.MuiAlert-colorSuccess')).not.toBeNull();
    expect(container.textContent).toContain('保存成功');
  });

  it('loading 返回句柄，close 后消息消失', async () => {
    act(() => {
      root.render(<Md3MessageHost />);
    });
    let handle: { close: () => void } | undefined;
    act(() => {
      handle = MessagePlugin.loading('处理中…');
    });
    expect(container.textContent).toContain('处理中…');
    await act(async () => {
      MessagePlugin.close(handle);
    });
    expect(container.textContent).not.toContain('处理中…');
  });

  it('TDesign 对象形态入参（{content, duration}）正确渲染——回归 #31 崩溃', () => {
    act(() => {
      root.render(<Md3MessageHost />);
    });
    act(() => {
      MessagePlugin.success({ content: '对象参数消息', duration: 0 });
    });
    expect(container.textContent).toContain('对象参数消息');
    expect(container.querySelector('.MuiAlert-root')).not.toBeNull();
  });

  it('duration 到期自动关闭', () => {
    act(() => {
      root.render(<Md3MessageHost />);
    });
    act(() => {
      MessagePlugin.info('自动关闭', 3000);
    });
    expect(container.textContent).toContain('自动关闭');
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(container.textContent).not.toContain('自动关闭');
  });

  it('showMd3Message 直接发布（总线契约）', () => {
    act(() => {
      root.render(<Md3MessageHost />);
    });
    act(() => {
      showMd3Message({ severity: 'error', content: '出错了', duration: 0 });
    });
    expect(container.querySelector('.MuiAlert-root')).not.toBeNull();
    expect(container.querySelector('.MuiAlert-colorError')).not.toBeNull();
    expect(container.textContent).toContain('出错了');
  });
});

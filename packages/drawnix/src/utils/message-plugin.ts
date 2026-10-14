/**
 * 全局消息服务（TDesign MessagePlugin 兼容 API，MUI Alert 渲染层）。
 *
 * - 渲染由 theme/md3-message.tsx 的 Md3MessageHost 承担（挂载在
 *   Md3ThemeProvider 内），本模块仅向全局总线发布消息。
 * - 导出 API 与 TDesign MessagePlugin 保持一致（success/error/warning/info/
 *   loading/close；第二参数 duration ms），既有调用点零改动。
 * - 宿主未挂载（极端时序/纯工具环境）时降级 console.warn，不抛错。
 */
import type { ReactNode } from 'react';
import {
  hasMd3MessageListeners,
  showMd3Message,
  type Md3MessageHandle,
  type Md3MessageSeverity,
} from '../theme/md3-message';

type MessageArgs = [unknown, number?];
type MessageInstanceLike = { close?: () => void } | null | undefined;
type ResolvedMessageInstanceLike = NonNullable<MessageInstanceLike>;
type LazyMessageInstance = Promise<MessageInstanceLike> & {
  __aituLazyMessageInstance: true;
  instancePromise: Promise<MessageInstanceLike>;
};

const DEFAULT_DURATION = 3000;
const LOADING_DURATION = 0; // loading 常驻，由 close() 关闭

function isLazyMessageInstance(value: unknown): value is LazyMessageInstance {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as LazyMessageInstance).__aituLazyMessageInstance === true
  );
}

function isPromiseLikeMessageInstance(
  value: unknown
): value is Promise<MessageInstanceLike> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<MessageInstanceLike>).then === 'function'
  );
}

function isResolvedMessageInstance(
  value: unknown
): value is ResolvedMessageInstanceLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as NonNullable<MessageInstanceLike>).close === 'function'
  );
}

function callMessage(
  method: Exclude<Md3MessageSeverity, 'loading'>,
  args: MessageArgs
): void {
  const [content, duration] = args;
  if (!hasMd3MessageListeners()) {
    console.warn(
      '[MessagePlugin] Md3MessageHost 未挂载，消息未渲染:',
      typeof content === 'string' ? content : '(node)'
    );
    return;
  }
  showMd3Message({
    severity: method,
    content: content as ReactNode,
    duration:
      typeof duration === 'number' && duration > 0 ? duration : DEFAULT_DURATION,
  });
}

export const MessagePlugin = {
  success(...args: MessageArgs): void {
    callMessage('success', args);
  },
  error(...args: MessageArgs): void {
    callMessage('error', args);
  },
  warning(...args: MessageArgs): void {
    callMessage('warning', args);
  },
  info(...args: MessageArgs): void {
    callMessage('info', args);
  },
  loading(...args: MessageArgs): LazyMessageInstance {
    const [content] = args;
    const handle: Md3MessageHandle = hasMd3MessageListeners()
      ? showMd3Message({
          severity: 'loading',
          content: content as ReactNode,
          duration: LOADING_DURATION,
        })
      : { close: () => undefined };

    const instancePromise = Promise.resolve<MessageInstanceLike>({
      close: () => handle.close(),
    });

    return Object.assign(instancePromise, {
      __aituLazyMessageInstance: true,
      instancePromise,
    } as const);
  },
  close(instance?: unknown): void {
    if (isLazyMessageInstance(instance)) {
      void instance.instancePromise
        .then((resolvedInstance) => {
          resolvedInstance?.close?.();
        })
        .catch(() => undefined);
      return;
    }

    if (isResolvedMessageInstance(instance)) {
      instance.close?.();
      return;
    }

    if (isPromiseLikeMessageInstance(instance)) {
      void instance
        .then((resolvedInstance) => {
          resolvedInstance?.close?.();
        })
        .catch(() => undefined);
      return;
    }
  },
};

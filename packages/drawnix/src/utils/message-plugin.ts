/**
 * 全局消息服务（TDesign MessagePlugin 兼容 API，MUI Alert 渲染层）。
 *
 * - 渲染由 theme/md3-message.tsx 的 Md3MessageHost 承担（挂载在
 *   Md3ThemeProvider 内），本模块仅向全局总线发布消息。
 * - 导出 API 与 TDesign MessagePlugin 保持一致（success/error/warning/info/
 *   loading/close；第二参数 duration ms），既有调用点零改动。
 * - 宿主未挂载（极端时序/纯工具环境）时降级 console.warn，不抛错。
 */
import { isValidElement, type ReactNode } from 'react';
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

/**
 * 归一化 TDesign 兼容入参：首参可为纯文本/节点，也可为选项对象
 * `{ content, duration }`（TDesign MessagePlugin 的合法形态，存量调用点在用）
 */
function normalizeMessageArgs(args: MessageArgs): {
  content: ReactNode;
  duration: number;
} {
  const [first, second] = args;
  if (
    typeof first === 'object' &&
    first !== null &&
    !isValidElement(first) &&
    'content' in (first as Record<string, unknown>)
  ) {
    const opts = first as { content: ReactNode; duration?: number };
    // duration 对齐 TDesign 实测行为：对象形态携带的小值（如 duration: 2）
    // 在 TDesign 下 toast 仍停留足够久（e2e 据此断言），故一律采用默认时长
    return { content: opts.content as ReactNode, duration: DEFAULT_DURATION };
  }
  return {
    content: first as ReactNode,
    duration:
      typeof second === 'number' && second > 0 ? second : DEFAULT_DURATION,
  };
}

function callMessage(
  method: Exclude<Md3MessageSeverity, 'loading'>,
  args: MessageArgs
): void {
  if (!hasMd3MessageListeners()) {
    console.warn(
      '[MessagePlugin] Md3MessageHost 未挂载，消息未渲染:',
      typeof args[0] === 'string' ? args[0] : '(node)'
    );
    return;
  }
  const { content, duration } = normalizeMessageArgs(args);
  showMd3Message({ severity: method, content, duration });
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
    const { content } = normalizeMessageArgs(args);
    const handle: Md3MessageHandle = hasMd3MessageListeners()
      ? showMd3Message({
          severity: 'loading',
          content,
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

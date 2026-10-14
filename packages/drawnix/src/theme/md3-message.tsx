/**
 * MD3 消息宿主与全局总线（adopt-material-design-3：消息层 MUI 化）。
 *
 * - Md3MessageHost：挂载在 Md3ThemeProvider 内，渲染顶部居中的 MUI Alert 堆栈
 *   （MD3 surface/elevation 令牌配色），替代 TDesign MessagePlugin 的渲染层。
 * - showMd3Message：全局命令入口（非组件代码可调用）；无宿主挂载时消息入队但
 *   不渲染（message-plugin 侧降级为 console.warn 提示）。
 *
 * utils/message-plugin.ts 保持 TDesign MessagePlugin 兼容 API
 * （success/error/warning/info/loading/close），调用点零改动。
 */
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import React, { useEffect, useState } from 'react';

export type Md3MessageSeverity =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'loading';

export interface Md3MessageEntry {
  key: number;
  severity: Md3MessageSeverity;
  content: React.ReactNode;
  /** 0 = 常驻（loading），由 close() 手动关闭 */
  duration: number;
}

type Listener = (entries: Md3MessageEntry[]) => void;

let entries: Md3MessageEntry[] = [];
let nextKey = 1;
const listeners = new Set<Listener>();

function emit(): void {
  const snapshot = [...entries];
  listeners.forEach((listener) => listener(snapshot));
}

export interface Md3MessageHandle {
  close: () => void;
}

/** 发布一条消息；返回可关闭句柄（loading 场景由调用方持有并 close） */
export function showMd3Message(entry: {
  severity: Md3MessageSeverity;
  content: React.ReactNode;
  duration: number;
}): Md3MessageHandle {
  const key = nextKey++;
  entries = [...entries, { key, ...entry }];
  emit();
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    entries = entries.filter((e) => e.key !== key);
    emit();
  };
  if (entry.duration > 0) {
    window.setTimeout(close, entry.duration);
  }
  return { close };
}

/** 无宿主挂载时是否有订阅者（message-plugin 用于降级提示） */
export function hasMd3MessageListeners(): boolean {
  return listeners.size > 0;
}

/** 仅供测试：清空总线消息（模块级状态会跨测试存活） */
export function _resetMd3MessagesForTests(): void {
  entries = [];
  emit();
}

/** 消息宿主：挂在 Md3ThemeProvider 内（drawnix 根 + apps/web 登录壳） */
export function Md3MessageHost(): React.ReactElement {
  const [list, setList] = useState<Md3MessageEntry[]>([]);
  useEffect(() => {
    const listener: Listener = (snapshot) => setList(snapshot);
    listeners.add(listener);
    listener([...entries]);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <div
      className="md3-message-host"
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2600,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        pointerEvents: 'none',
        width: 'min(92vw, 560px)',
      }}
    >
      {list.map((entry) => (
        <Alert
          key={entry.key}
          variant="filled"
          severity={entry.severity === 'loading' ? 'info' : entry.severity}
          icon={
            entry.severity === 'loading' ? (
              <CircularProgress size={18} color="inherit" />
            ) : undefined
          }
          sx={{
            pointerEvents: 'auto',
            borderRadius: '8px',
            boxShadow: 'var(--md3-elevation-2)',
            alignItems: 'center',
            width: '100%',
          }}
        >
          {entry.content as React.ReactNode}
        </Alert>
      ))}
    </div>
  );
}

/**
 * /canvas-ai 宿主页:全屏 iframe 承载嵌入的无限画布工作台(/infinite/)。
 *
 * 独立构建的 React 19 子应用挂在同域 /infinite/ 静态路径(生产由 busybox
 * httpd 伺服,开发由主应用 vite proxy 转发);本组件只提供平台壳:返回画布
 * + 全屏画布。挂载即 markLoadingComplete,防主画布崩溃恢复误报(同 /workflow)。
 */
import React, { useEffect, useState } from 'react';
import { crashRecoveryService } from '@drawnix/drawnix/runtime';

/** 惰性挂载:bootstrap 按 pathname 分流后动态 import 本组件,iframe 与子应用资源仅在进入 /canvas-ai 时加载 */
const CanvasAiHost: React.FC = () => {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // 本视图挂载成功 = 无「异常退出」;否则回主画布时遗留的 'loading'
    // 会被误判为连续崩溃(弹恢复窗,同 /workflow 编辑器的处理)
    crashRecoveryService.markLoadingComplete();
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f0f0f' }}>
      <iframe
        src="/infinite/"
        title="无限画布"
        onLoad={() => setLoaded(true)}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          border: 'none',
        }}
      />
      <button
        type="button"
        data-testid="canvas-ai-back"
        onClick={() => {
          window.location.href = '/';
        }}
        style={{
          position: 'fixed',
          top: 12,
          left: 12,
          zIndex: 2147483000,
          padding: '6px 12px',
          borderRadius: 999,
          border: '1px solid rgba(255,255,255,0.25)',
          background: 'rgba(20,20,20,0.72)',
          color: '#fff',
          fontSize: 13,
          cursor: 'pointer',
          backdropFilter: 'blur(8px)',
        }}
      >
        ← 画布
      </button>
      {!loaded ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.7)',
            fontSize: 14,
            pointerEvents: 'none',
          }}
        >
          正在打开无限画布…
        </div>
      ) : null}
    </div>
  );
};

export default CanvasAiHost;

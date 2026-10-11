/**
 * 按钮使用统计采集挂载点（openspec add-button-usage-stats）
 *
 * 渲染在 AuthGate 之内（仅在已登录工作区挂载），挂载即启动全局捕获监听，
 * 并在上报一帧后做一次启动按钮清单上报（inv: 前缀，零使用对比基线）。
 * StrictMode 双挂载安全：capture 内部 start/stop 幂等。
 */
import { useEffect } from 'react';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../supabase/supabase-client';
import { getAccessToken } from '../supabase/auth-context';
import { UiStatsCapture } from './ui-stats-capture';

export function UiStatsCaptureMount(): null {
  useEffect(() => {
    const capture = new UiStatsCapture({
      endpoint: `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/ui-stats/ingest`,
      anonKey: SUPABASE_ANON_KEY,
      getAccessToken,
    });
    capture.start();
    // 等一帧让工作区（含画布工具栏等懒挂载按钮）渲染完成后再采清单
    const raf = requestAnimationFrame(() => {
      void capture.reportInventory();
    });
    return () => {
      cancelAnimationFrame(raf);
      capture.stop();
    };
  }, []);
  return null;
}

export default UiStatsCaptureMount;

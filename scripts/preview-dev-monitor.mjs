#!/usr/bin/env node
/**
 * 开发监控看板本地纯前端预览（无需 Supabase 后端）
 *
 * 用法：
 *   node scripts/preview-dev-monitor.mjs [端口]   # 默认 7292
 *
 * 用 mock 数据渲染 buildDevMonitorHtml 生成的页面（登录壳跳过、/status 固定
 * 返回 mock），供前端改动过目与截图；不涉及任何真实数据。
 */

import { createServer } from 'node:http';
import { buildDevMonitorHtml } from '../supabase/functions/dev-monitor/core.ts';

const port = Number(process.argv[2] || 7292);

const fixture = {
  generatedAt: new Date().toISOString(),
  days: 7,
  probes: [
    { name: 'PostgREST', ok: true, status: 200, latencyMs: 12, detail: '正常' },
    { name: 'GoTrue 认证', ok: true, status: 200, latencyMs: 8, detail: '正常' },
    { name: 'Storage', ok: true, status: 200, latencyMs: 15, detail: '正常' },
    { name: 'ai-proxy 函数', ok: true, status: 401, latencyMs: 210, detail: '存活（未带 JWT 被 401 拒绝）' },
    { name: 'New API 网关', ok: true, status: 200, latencyMs: 45, detail: '正常' },
    { name: '网关管理令牌', ok: false, status: 401, latencyMs: 38, detail: 'HTTP 401（令牌失效？）' },
  ],
  pipeline: {
    counts: { completed: 298, failed: 17, cancelled: 5, submitted: 6, stuck: 3 },
    successRate: 0.9312,
    durationByType: {
      image: { count: 198, p50Ms: 38000, p95Ms: 92000, avgMs: 46000 },
      video: { count: 30, p50Ms: 300000, p95Ms: 560000, avgMs: 340000 },
      chat: { count: 70, p50Ms: 4000, p95Ms: 11000, avgMs: 5200 },
    },
    failuresByModel: [
      { model: 'gpt-image-2', failed: 9, total: 86, rate: 0.1047 },
      { model: 'gemini-2.5-pro-image', failed: 5, total: 120, rate: 0.0417 },
      { model: 'seedream-4.0', failed: 3, total: 60, rate: 0.05 },
      { model: 'flux-schnell', failed: 0, total: 40, rate: 0 },
    ],
    daily: [
      { date: '2026-09-10', total: 41, failed: 3 },
      { date: '2026-09-11', total: 52, failed: 2 },
      { date: '2026-09-12', total: 35, failed: 1 },
      { date: '2026-09-13', total: 47, failed: 4 },
      { date: '2026-09-14', total: 61, failed: 3 },
      { date: '2026-09-15', total: 58, failed: 2 },
      { date: '2026-09-16', total: 32, failed: 2 },
    ],
  },
  recentFailures: [
    {
      createdAt: '2026-09-16T11:24:00Z', oa: 'limh', type: 'image', model: 'gpt-image-2',
      durationMs: 31000, errorSummary: 'upstream timeout: no response in 30s (request id req_8f2a)',
    },
    {
      createdAt: '2026-09-16T10:58:00Z', oa: 'mengdc', type: 'image', model: 'gpt-image-2',
      durationMs: 12000, errorSummary: '{"code":429,"error":"rate limited by upstream, retry after 60s"}',
    },
    {
      createdAt: '2026-09-16T09:41:00Z', oa: null, type: 'video', model: 'kling-v2',
      durationMs: 590000, errorSummary: 'WorkerRequestCancelled: edge function killed after 60s while polling',
    },
    {
      createdAt: '2026-09-16T09:02:00Z', oa: 'wangyl', type: 'audio', model: 'suno-v5',
      durationMs: null, errorSummary: '',
    },
  ],
  stuckList: [
    {
      createdAt: '2026-09-16T08:12:00Z', oa: 'zhangsan', type: 'image', model: 'gpt-image-2',
      waitedMs: 3 * 3600_000 + 24 * 60_000, thresholdMs: 10 * 60_000,
    },
    {
      createdAt: '2026-09-16T11:30:00Z', oa: 'lisi', type: 'video', model: 'kling-v2',
      waitedMs: 35 * 60_000, thresholdMs: 30 * 60_000,
    },
  ],
};

const html = buildDevMonitorHtml('preview-anon-key-not-real')
  // 预览专用：跳过登录壳，直接加载数据（线上页面不受影响）
  .replace('if(session){ load(); setupAutoRefresh(); } else { showLogin(); }', 'load(); setupAutoRefresh();');

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.replace(/\/+$/, '').endsWith('/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(fixture));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(port, () => {
  console.log(`开发监控预览（mock 数据）: http://localhost:${port}/`);
  console.log('停止: Ctrl+C');
});

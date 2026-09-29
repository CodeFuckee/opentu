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
    failureCategories: { balance: 9, upstream: 4, platform: 4 },
    platformErrorRate: 0.0132,
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
    failureBreakdown: [
      { category: 'upstream_timeout', label: '上游超时', rollup: 'upstream', count: 5, share: 0.3125,
        lastSeenAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        lastSample: 'upstream timeout: no response in 30s (request id req_8f2a)' },
      { category: 'balance', label: '余额不足', rollup: 'balance', count: 4, share: 0.25,
        lastSeenAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
        lastSample: '{"error":{"code":"insufficient_user_quota","message":"账户余额不足，请充值"}}' },
      { category: 'auth', label: '认证/令牌失败', rollup: 'platform', count: 3, share: 0.1875,
        lastSeenAt: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
        lastSample: 'upstream key unavailable: 未配置该模型的网关令牌' },
      { category: 'content_policy', label: '内容审核拒绝', rollup: 'platform', count: 2, share: 0.125,
        lastSeenAt: new Date(Date.now() - 26 * 3600 * 1000).toISOString(),
        lastSample: 'content_policy_violation: prompt flagged as sensitive' },
      { category: 'platform_timeout', label: '处理超时', rollup: 'platform', count: 1, share: 0.0625,
        lastSeenAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
        lastSample: 'IMAGE_GENERATION_TIMEOUT after 300000ms' },
      { category: 'platform_other', label: '其他平台错误', rollup: 'platform', count: 1, share: 0.0625,
        lastSeenAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
        lastSample: 'TypeError: Cannot read properties of null (reading args)' },
      { category: 'upstream_http', label: '上游网关错误(5xx)', rollup: 'upstream', count: 0, share: 0,
        lastSeenAt: null, lastSample: null },
      { category: 'upstream_error', label: '其他上游错误', rollup: 'upstream', count: 0, share: 0,
        lastSeenAt: null, lastSample: null },
    ],
    daily: [
      { date: '2026-09-10', total: 41, failed: 3, completed: 33, cancelled: 5, platformFailed: 1, successRate: 0.8049, platformErrorRate: 0.0256 },
      { date: '2026-09-11', total: 52, failed: 2, completed: 44, cancelled: 6, platformFailed: 0, successRate: 0.8462, platformErrorRate: 0 },
      { date: '2026-09-12', total: 35, failed: 1, completed: 30, cancelled: 4, platformFailed: 1, successRate: 0.8571, platformErrorRate: 0.0286 },
      { date: '2026-09-13', total: 47, failed: 4, completed: 38, cancelled: 5, platformFailed: 3, successRate: 0.8085, platformErrorRate: 0.0652 },
      { date: '2026-09-14', total: 61, failed: 3, completed: 50, cancelled: 8, platformFailed: 1, successRate: 0.8197, platformErrorRate: 0.0169 },
      { date: '2026-09-15', total: 58, failed: 2, completed: 48, cancelled: 8, platformFailed: 0, successRate: 0.8276, platformErrorRate: 0 },
      { date: '2026-09-16', total: 32, failed: 2, completed: 27, cancelled: 3, platformFailed: 2, successRate: 0.8438, platformErrorRate: 0.0667 },
      { date: '2026-09-17', total: 2, failed: 0, completed: 0, cancelled: 0, platformFailed: 0, successRate: null, platformErrorRate: null },
    ],
  },
  recentFailures: [
    {
      createdAt: '2026-09-16T11:24:00Z', oa: 'limh', type: 'image', model: 'gpt-image-2',
      durationMs: 31000, errorSummary: 'upstream timeout: no response in 30s (request id req_8f2a)',
    },
    {
      createdAt: '2026-09-16T10:58:00Z', oa: 'mengdc', type: 'image', model: 'gpt-image-2',
      durationMs: 12000, errorSummary: '{"error":{"code":"insufficient_user_quota","message":"账户余额不足，请充值"}}',
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
  resultIntegrity: {
    fileTaskTotal: 298,
    notArchived: 3,
    missingFromBucket: 2,
    zeroSize: 1,
    unverified: 0,
    samples: [
      { path: 'mengdc/2026-09-16/9f2a1b.png', issue: 'missing', oa: 'mengdc', size: null },
      { path: 'limh/2026-09-16/7c31de.png', issue: 'zero', oa: 'limh', size: 0 },
      { path: '(任务无归档结果路径)', issue: 'not_archived', oa: 'wangyl', size: null },
    ],
  },
  bucketUsage: {
    buckets: [
      { bucketId: 'huabu', public: false, objectCount: 18432, totalBytes: 128 * 1024 ** 3 + 512 * 1024 ** 2 },
      { bucketId: 'jzxz-materials', public: true, objectCount: 642, totalBytes: 2 * 1024 ** 3 + 400 * 1024 ** 2 },
      { bucketId: 'templates', public: true, objectCount: 1307, totalBytes: 800 * 1024 ** 2 },
      { bucketId: 'user-avatars', public: true, objectCount: 58, totalBytes: 3 * 1024 ** 2 + 200 * 1024 },
      { bucketId: 'empty-private', public: false, objectCount: 0, totalBytes: 0 },
    ],
    totalObjects: 18432 + 642 + 1307 + 58,
    totalBytes:
      128 * 1024 ** 3 + 512 * 1024 ** 2 +
      2 * 1024 ** 3 + 400 * 1024 ** 2 +
      800 * 1024 ** 2 +
      3 * 1024 ** 2 + 200 * 1024,
  },
  crawlStats: {
    fromIso: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
    libraries: [
      { key: 'templates', label: '模板', addedCount: 3, totalCount: 1310, lastIngestedAt: new Date(Date.now() - 26 * 3600 * 1000).toISOString() },
      { key: 'textures', label: '贴图素材（家居/植物/配景）', addedCount: 217, totalCount: 9318, lastIngestedAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString() },
      { key: 'home_models', label: '家居产品模型', addedCount: null, totalCount: null, lastIngestedAt: null },
      { key: 'plant_models', label: '植物模型', addedCount: 0, totalCount: 96, lastIngestedAt: new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString() },
    ],
  },
};

// 预览专用：跳过登录壳，直接加载数据（线上页面不受影响）。
// 精确字符串 replace：源文案变化即静默退化成「预览页要登录」，未命中时告警
const loginShellSource =
  'if(session){ load(); setupAutoRefresh(); } else { showLogin(); }';
let html = buildDevMonitorHtml('preview-anon-key-not-real');
if (!html.includes(loginShellSource)) {
  console.warn(
    '[preview-dev-monitor] 登录壳代码片段未命中，预览页将停在登录界面（dev-monitor/core.ts 文案可能已变化）'
  );
}
html = html.replace(loginShellSource, 'load(); setupAutoRefresh();');

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.replace(/\/+$/, '').endsWith('/status')) {
    // days 跟随 query 回显，切窗口时标题/口径与真实后端一致
    const days = Number(url.searchParams.get('days')) || fixture.days;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...fixture, days }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(port, () => {
  console.log(`开发监控预览（mock 数据）: http://localhost:${port}/`);
  console.log('停止: Ctrl+C');
});

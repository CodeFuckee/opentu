#!/usr/bin/env node
/**
 * 数据看板本地纯前端预览（无需 Supabase 后端）
 *
 * 用法：
 *   node scripts/preview-dashboard-stats.mjs [端口]   # 默认 7291
 *
 * 用 mock 数据渲染 buildDashboardHtml 生成的看板页面（登录壳跳过、
 * /overview 固定返回 mock），供前端改动过目与截图；不涉及任何真实数据。
 * 「领导视角 · 核心指标」的 mock 数值参照课题汇报口径（8298 次调用、
 * 1138 张图等），仅用于视觉核对，非真实统计。
 */

import { createServer } from 'node:http';
import {
  buildDashboardHtml,
  buildOverviewWorkbook,
} from '../supabase/functions/dashboard-stats/core.ts';

const port = Number(process.argv[2] || 7291);

function iso(daysAgo, hour = 9) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hour)}:00:00+08:00`;
}

// 近 7 天趋势（权重靠后更高，热力图/趋势线更直观）
const dailyTrend = Array.from({ length: 7 }, (_, i) => ({
  date: iso(6 - i).slice(0, 10),
  count: [28, 35, 41, 52, 47, 63, 54][i],
}));

const fixture = {
  generatedAt: new Date().toISOString(),
  days: 7,
  usdCnyRate: 0.1,
  weekTasks: 320,
  monthCostUsd: 128.4,
  tasks: {
    total: 320,
    byType: { image: 210, chat: 68, video: 30, audio: 12 },
    byModel: {
      'gemini-2.5-pro-image': 420,
      'gpt-image-2': 260,
      'seedream-4.0': 180,
      'flux-schnell': 95,
      'qwen-image': 41,
    },
    activeUsers: 23,
    avgDurationMs: 42000,
    dailyTrend,
    hourly: [1, 0, 0, 0, 0, 2, 5, 12, 28, 42, 55, 61, 48, 52, 60, 58, 49, 44, 38, 30, 22, 14, 8, 3],
    topUsers: [
      { userId: 'u1', displayName: '孟杜翀', department: '方案中心', count: 86 },
      { userId: 'u2', displayName: '李敏浩', department: '方案中心', count: 64 },
    ],
    userUsage: [
      { userId: 'u1', displayName: '孟杜翀', department: '方案中心', count: 86 },
      { userId: 'u2', displayName: '李敏浩', department: '方案中心', count: 64 },
      { userId: 'u3', displayName: '周砚秋', department: '环艺中心', count: 51 },
      { userId: 'u4', displayName: '陈临', department: '智能建造', count: 40 },
    ],
    totalCostUsd: 96.5,
  },
  usage: {
    quotaLimit: 200,
    byPeriod: [
      { period: '2026-07', used: 742 },
      { period: '2026-08', used: 810 },
      { period: '2026-09', used: 640 },
    ],
    latestPeriod: '2026-09',
    latestUsed: 640,
    topUsers: [
      { oaAccount: 'mengdc', displayName: '孟杜翀', department: '方案中心', used: 86 },
      { oaAccount: 'limh', displayName: '李敏浩', department: '方案中心', used: 64 },
    ],
  },
  users: {
    total: 46,
    byDepartment: { 方案中心: 18, 环艺中心: 9, 智能建造: 8, 职能部门: 6, 数字化中心: 5 },
    byRegion: { 广州: 22, 深圳: 10, 成都: 8, 武汉: 6 },
    usageByDepartment: { 方案中心: 156, 环艺中心: 62, 智能建造: 55, 数字化中心: 32, 职能部门: 15 },
    usageByRegion: { 广州: 168, 深圳: 74, 成都: 51, 武汉: 27 },
    costByDepartment: { 方案中心: 47.1, 环艺中心: 18.7, 智能建造: 16.6, 数字化中心: 9.6, 职能部门: 4.5 },
    staffDirectory: 300,
    enabledDepartments: 8,
  },
  leadership: {
    windowImages: 458,
    windowImageTasks: 210,
    avgImageDurationMs: 38000,
    topModel: 'gemini-2.5-pro-image',
    topModelCount: 420,
    modelTypes: 5,
    tokens: 1623784,
    allTimeCalls: 8298,
    allTimeImageTasks: 3590,
    outsourcePriceCny: 80,
    outsourceEquivalentCny: 36640,
    savedCny: 36630.35,
  },
};

// 按钮使用统计 mock（固定近 7/30 天口径，与生产面板一致，不随预览区间变化）
const buttonUsageFixture = {
  top7d: [
    { buttonId: 'btn-ai-generate', label: '生成图片', count: 128, users: 18, lastSeenAt: iso(0, 18) },
    { buttonId: 'btn-export-png', label: '导出图片', count: 66, users: 9, lastSeenAt: iso(1, 10) },
  ],
  top30d: [
    { buttonId: 'btn-ai-generate', label: '生成图片', count: 512, users: 26, lastSeenAt: iso(0, 18) },
    { buttonId: 'btn-export-png', label: '导出图片', count: 240, users: 14, lastSeenAt: iso(1, 10) },
  ],
  dailyTrend: dailyTrend.map((p) => ({ date: p.date, count: p.count * 4 })),
  unused: ['inv:toolbox-legacy-plugin'],
  inventoryCount: 257,
};

// 预览导出 Excel：用同一 mock fixture 走生产同款 buildOverviewWorkbook（浏览器下载后可直接打开）
function exportXlsx(searchParams) {
  const overview = JSON.parse(JSON.stringify(fixture));
  const start = searchParams.get('start');
  const end = searchParams.get('end');
  if (start && end) {
    overview.days = Math.max(
      1,
      Math.round((Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`)) / 86400000) + 1
    );
  }
  return buildOverviewWorkbook(overview, {
    rangeLabel: start && end ? `${start} ~ ${end}` : `近 ${overview.days} 天`,
    buttonUsage: buttonUsageFixture,
  });
}

// 预览专用：跳过登录壳，直接加载数据（线上页面不受影响）。
// 精确字符串 replace：源文案变化即静默退化成「预览页要登录」，未命中时告警
const loginShellSource = 'if(session){ load(); } else { showLogin(); }';
let html = buildDashboardHtml('preview-anon-key-not-real');
if (!html.includes(loginShellSource)) {
  console.warn(
    '[preview-dashboard-stats] 登录壳代码片段未命中，预览页将停在登录界面（dashboard-stats/core.ts 文案可能已变化）'
  );
}
html = html.replace(loginShellSource, 'load();');

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/overview')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(fixture));
    return;
  }
  if (path.endsWith('/button-usage')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(buttonUsageFixture));
    return;
  }
  if (path.endsWith('/export')) {
    try {
      const bytes = exportXlsx(url.searchParams);
      res.writeHead(200, {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="dashboard-stats.xlsx"',
      });
      res.end(Buffer.from(bytes));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(port, () => {
  console.log(`看板预览（mock 数据）: http://localhost:${port}/`);
  console.log('停止: Ctrl+C');
});

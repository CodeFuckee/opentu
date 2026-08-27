#!/usr/bin/env node
/**
 * ai-proxy 边缘函数部署冒烟检查
 *
 * 用法：
 *   node scripts/edge-function-smoke.mjs [supabaseBase] [anonKey]
 * 例：
 *   node scripts/edge-function-smoke.mjs http://10.37.80.25:8021
 *
 * 检查项（全部通过=函数已正确部署、数据库迁移已执行）：
 *   1. 未带 JWT 调 GET  {base}/functions/v1/ai-proxy/quota        → 401 {"error":"unauthorized: missing bearer token"}
 *   2. 未带 JWT 调 POST {base}/functions/v1/ai-proxy/v1/images/generations → 401（不应有上游调用）
 *   3. 管控表已创建：GET {base}/rest/v1/generation_usage?select=*&limit=1
 *      （用 anon 公钥查询；RLS 下正常返回空数组 []）
 *
 * 典型故障对照：
 *   - 返回 {"msg":"InvalidWorkerCreation: ... could not find an appropriate entrypoint"}
 *     → 函数目录未部署到 volumes/functions/（或目录结构不对），见 docs/ai-proxy-edge-function.md
 *   - 返回 PGRST205 Could not find the table 'generation_usage'
 *     → 数据库迁移未执行（supabase/migrations/generation_usage.sql）
 */

const DEFAULT_BASE = 'http://10.37.80.25:8021';
const DEFAULT_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE';

const base = (process.argv[2] || DEFAULT_BASE).replace(/\/+$/, '');
const anonKey = process.argv[3] || process.env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;

let failures = 0;

function report(name, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) {
    failures++;
    console.log(`   ${detail}`);
  }
}

async function check(name, fn) {
  try {
    const { ok, detail } = await fn();
    report(name, ok, detail);
  } catch (err) {
    report(name, false, `网络错误: ${err.message}`);
  }
}

await check('GET /functions/v1/ai-proxy/quota → 应返回我们函数的 401 JSON', async () => {
  const res = await fetch(`${base}/functions/v1/ai-proxy/quota`);
  const text = await res.text();
  const isInfraError = text.includes('InvalidWorkerCreation');
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (isInfraError || !(res.status === 401 && payload?.error === 'unauthorized: missing bearer token')) {
    return {
      ok: false,
      detail: `HTTP ${res.status} 响应: ${text.slice(0, 200)}\n` +
        (text.includes('InvalidWorkerCreation')
          ? '→ ai-proxy 函数未部署：把 supabase/functions/ai-proxy 拷到服务器 volumes/functions/ 后重试'
          : '→ 与预期响应不符'),
    };
  }
  return { ok: true };
});

await check('POST /functions/v1/ai-proxy/v1/images/generations → 无JWT应为401且不触发上游', async () => {
  const res = await fetch(`${base}/functions/v1/ai-proxy/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'smoke' }),
  });
  const text = await res.text();
  if (res.status === 500 && text.includes('InvalidWorkerCreation')) {
    return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 160)} → 同上，函数未部署` };
  }
  if (res.status !== 401) {
    return { ok: false, detail: `期望 401，实际 HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
});

await check('伪造 JWT 调 quota → 必须拒绝(401)，不得放行', async () => {
  const forged =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c0GNz9UXr0u5EOCuKCSnRgcBMRUFDOhxbCUZKJoxTAo';
  const res = await fetch(`${base}/functions/v1/ai-proxy/quota`, {
    headers: { Authorization: `Bearer ${forged}` },
  });
  const text = await res.text();
  if (res.status !== 401) {
    return { ok: false, detail: `期望 401，实际 HTTP ${res.status}: ${text.slice(0, 160)}` };
  }
  return { ok: true };
});

await check('数据表 generation_usage 已由迁移创建(rest/v1 可达)', async () => {
  const res = await fetch(`${base}/rest/v1/generation_usage?select=*&limit=1`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  const text = await res.text();
  if (text.includes('PGRST205')) {
    return {
      ok: false,
      detail: `迁移未执行：${text.slice(0, 160)}\n→ docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/generation_usage.sql`,
    };
  }
  // 表存在时：anon 被授权则返回 200 []；未授权（默认收紧）返回 42501 权限错误——两者都证明表已建
  if (res.ok || text.includes('42501')) {
    return { ok: true };
  }
  return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
});

console.log(
  failures === 0
    ? `\n全部通过：ai-proxy 已部署且迁移已应用（${base}）`
    : `\n${failures} 项未通过 —— 见上方每条的诊断提示`
);
process.exit(failures === 0 ? 0 : 1);

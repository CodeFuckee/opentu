#!/usr/bin/env node
/**
 * 以图搜图(#61):四库图片 CLIP 向量批量构建脚本。
 *
 * 职责:读四库(贴图/家居/植物/模板封面)→ 拉公开桶图 → transformers.js CLIP
 * 编码(512 维,q8)→ upsert asset_vectors。查询侧(浏览器)与本脚本共用
 * 同一模型(Xenova/clip-vit-base-patch32),保证向量空间一致。
 *
 * 模型下载:默认走 HuggingFace;国内网络先设环境变量
 *   HF_ENDPOINT=https://hf-mirror.com
 * 首次下载后落本地缓存,重跑离线可用。
 *
 * 用法(node ≥18,无需额外依赖):
 *   SUPABASE_URL=http://10.37.80.25:8021 \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role key> \
 *   node scripts/build-asset-vectors.mjs                     # 全量(自动跳过已有)
 *   node scripts/build-asset-vectors.mjs --dry-run           # 只统计不写库
 *   node scripts/build-asset-vectors.mjs --limit 50          # 只处理前 50 张(冒烟)
 *   node scripts/build-asset-vectors.mjs --since 2026-09-28  # 增量:updated_at 晚于该值的行
 *   node scripts/build-asset-vectors.mjs --type jzxz_home_materials
 *   node scripts/build-asset-vectors.mjs --force             # 忽略已有向量全部重算
 *
 * 幂等:唯一键 (asset_type,asset_id,image_url) 冲突即更新;中断重跑安全。
 * 失败(拉图/编码/写库)不中断,清单落盘 data/asset-vectors-failures.json。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ARGV = parseArgs(process.argv.slice(2));
const SUPABASE_URL = (ARGV.url || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_ROLE_KEY = ARGV.key || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DRY_RUN = Boolean(ARGV['dry-run']);
const FORCE = Boolean(ARGV.force);
const LIMIT = Number(ARGV.limit ?? 0); // 0=不限
const SINCE = String(ARGV.since || '');
const ONLY_TYPE = String(ARGV.type || '');

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const MODEL_VERSION = 'clip-vit-b32-int8-v1';
const EMBEDDING_DIM = 512;
const PAGE_SIZE = 1000; // PGRST db-max-rows 兼容:range 按实收行数推进
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const UPSERT_BATCH = 100;

if (!SUPABASE_URL) fail('缺少 SUPABASE_URL(可用 --url 或环境变量提供)');
if (!SERVICE_ROLE_KEY) fail('缺少 SUPABASE_SERVICE_ROLE_KEY(可用 --key 或环境变量提供)');

const HEADERS = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

/** 各库取数列与图片直链映射(与前端 official-library-service 同口径) */
const LIBRARY_CONFIG = {
  jzxz_materials: {
    select: 'source_id,file_path,updated_at',
    urls: (row) =>
      row.file_path
        ? [`${SUPABASE_URL}/storage/v1/object/public/jzxz-materials/${row.file_path}`]
        : [],
  },
  jzxz_home_materials: {
    select: 'source_id,image_paths,updated_at',
    urls: (row) => multiViewUrls('jzxz-home-materials', row),
  },
  jzxz_plant_materials: {
    select: 'source_id,image_paths,updated_at',
    urls: (row) => multiViewUrls('jzxz-plant-materials', row),
  },
  ai_templates: {
    select: 'source_id,cover_public_url,updated_at',
    urls: (row) => (row.cover_public_url ? [row.cover_public_url] : []),
  },
};

function multiViewUrls(bucket, row) {
  return (Array.isArray(row.image_paths) ? row.image_paths : [])
    .filter(Boolean)
    .map((p) => `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${p}`);
}

// ---------------------------------------------------------------------------
// 通用辅助
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

function fail(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

async function apiJson(pathname, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...opts,
    headers: { ...HEADERS, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`${opts.method || 'GET'} ${pathname} -> ${res.status}: ${text}`);
  }
  return res.json();
}

/** 分页拉全量行:老版 PostgREST 不认 range= 查询参数,用标准 Range 头(按实收行数推进) */
async function fetchAllRows(table, select, sinceIso) {
  const rows = [];
  let offset = 0;
  for (;;) {
    let q = `/rest/v1/${table}?select=${encodeURIComponent(select)}&order=source_id.asc`;
    if (sinceIso) q += `&updated_at=gte.${encodeURIComponent(sinceIso)}`;
    const page = await apiJson(q, {
      headers: {
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
        'Range-Unit': 'items',
      },
    });
    rows.push(...page);
    process.stdout.write(`\r  ${table}: ${rows.length} 行`);
    if (!Array.isArray(page) || page.length < PAGE_SIZE) break;
    offset += page.length;
  }
  process.stdout.write('\n');
  return rows;
}

/** 行 → 一图一条的任务清单(家居/植物多视图展开) */
function buildTasks(type, rows) {
  const tasks = [];
  for (const row of rows) {
    for (const url of LIBRARY_CONFIG[type].urls(row)) {
      tasks.push({ assetType: type, assetId: row.source_id, imageUrl: url });
    }
  }
  return tasks;
}

/** 已有向量键集合(断点续跑跳过) */
async function fetchExistingKeys() {
  const keys = new Set();
  let offset = 0;
  for (;;) {
    const page = await apiJson(
      '/rest/v1/asset_vectors?select=asset_type,asset_id,image_url&order=asset_type.asc',
      {
        headers: {
          Range: `${offset}-${offset + PAGE_SIZE - 1}`,
          'Range-Unit': 'items',
        },
      }
    );
    for (const r of page) {
      keys.add(`${r.asset_type}|${r.asset_id}|${r.image_url}`);
    }
    offset += page.length;
    if (!Array.isArray(page) || page.length < PAGE_SIZE) break;
  }
  return keys;
}

async function fetchImageBlob(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 批量写入:老版 PostgREST 不支持批量 upsert(PUT 需主键 eq 过滤的单行语义,
 * POST+resolution 对复合主键实测 409),改为两步——按 (asset_type, asset_id)
 * 先删后插:同素材旧向量(含已下架视图)整体替换,幂等且语义更干净。
 */
async function upsertVectors(rows) {
  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.asset_type)) byType.set(r.asset_type, new Set());
    byType.get(r.asset_type).add(r.asset_id);
  }
  for (const [type, ids] of byType) {
    const filter = `?asset_type=eq.${encodeURIComponent(type)}&asset_id=in.(${[...ids]
      .map((id) => `"${id.replace(/"/g, '\\"')}"`)
      .join(',')})`;
    const del = await fetch(`${SUPABASE_URL}/rest/v1/asset_vectors${filter}`, {
      method: 'DELETE',
      headers: HEADERS,
    });
    if (!del.ok) {
      throw new Error(`delete -> ${del.status}: ${(await del.text()).slice(0, 200)}`);
    }
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/asset_vectors`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`insert -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[asset-vectors] 模型=${MODEL_ID} 版本=${MODEL_VERSION}`);
  if (DRY_RUN) console.log('[asset-vectors] DRY-RUN:只统计不写库');

  // 1. 收集任务
  const types = ONLY_TYPE
    ? [ONLY_TYPE]
    : ['jzxz_materials', 'jzxz_home_materials', 'jzxz_plant_materials', 'ai_templates'];
  const sinceIso = SINCE ? new Date(`${SINCE}T00:00:00+08:00`).toISOString() : '';
  let tasks = [];
  for (const type of types) {
    const { select } = LIBRARY_CONFIG[type];
    const rows = await fetchAllRows(type, select, sinceIso);
    const t = buildTasks(type, rows);
    console.log(`  ${type}: ${rows.length} 行 → ${t.length} 张图`);
    tasks.push(...t);
  }

  // 2. 键内去重(上游表存在 source_id+file_path 完全重复的行,同批重复键会使
  //    单条 INSERT 语句自身冲突) + 断点过滤
  const seen = new Set();
  tasks = tasks.filter((t) => {
    const k = `${t.assetType}|${t.assetId}|${t.imageUrl}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let skipCount = 0;
  if (!FORCE && !DRY_RUN) {
    console.log('[asset-vectors] 拉取已有向量键(断点续跑)...');
    const existing = await fetchExistingKeys();
    const before = tasks.length;
    tasks = tasks.filter(
      (t) => !existing.has(`${t.assetType}|${t.assetId}|${t.imageUrl}`)
    );
    skipCount = before - tasks.length;
  }
  if (LIMIT > 0) tasks = tasks.slice(0, LIMIT);
  console.log(
    `[asset-vectors] 待处理 ${tasks.length} 张(跳过已有 ${skipCount})${DRY_RUN ? ' [dry-run]' : ''}`
  );
  if (DRY_RUN || tasks.length === 0) return;

  // 3. 编码器(transformers.js 与浏览器查询侧共用同一模型)
  const { pipeline, RawImage, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false; // 远端拉取,本地缓存自动复用
  if (process.env.HF_ENDPOINT) {
    // 该版本不自动读 HF_ENDPOINT,显式指定(国内网络用 https://hf-mirror.com)
    env.remoteHost = process.env.HF_ENDPOINT.replace(/\/+$/, '');
  }
  const extractor = await pipeline('image-feature-extraction', MODEL_ID, {
    dtype: 'q8',
  });

  // 4. 逐张编码 + 批量写库(拉图失败单张记失败,不中断)
  const failures = [];
  let done = 0;
  let buffered = [];
  const t0 = Date.now();

  const flush = async () => {
    if (buffered.length === 0) return;
    const batch = buffered;
    buffered = [];
    try {
      await upsertVectors(batch);
    } catch (error) {
      failures.push({
        batch: batch.length,
        error: String(error.message || error).slice(0, 200),
      });
    }
  };

  for (const task of tasks) {
    try {
      const blob = await fetchImageBlob(task.imageUrl);
      const image = await RawImage.fromBlob(blob);
      const output = await extractor(image, { pooling: 'mean', normalize: true });
      const vec = Array.from(output.data);
      if (vec.length !== EMBEDDING_DIM) {
        throw new Error(`维度异常 ${vec.length}`);
      }
      buffered.push({
        asset_type: task.assetType,
        asset_id: task.assetId,
        image_url: task.imageUrl,
        embedding: vec,
        model_version: MODEL_VERSION,
      });
      done++;
    } catch (error) {
      failures.push({
        ...task,
        error: String(error.message || error).slice(0, 160),
      });
    }
    if (buffered.length >= UPSERT_BATCH) await flush();
    const processed = done + failures.length;
    if (processed % 100 === 0) {
      const rate = processed / ((Date.now() - t0) / 1000);
      console.log(
        `  进度 ${processed}/${tasks.length}(成功 ${done} 失败 ${failures.length}` +
          ` ${rate.toFixed(1)} 张/s 预计剩 ${((tasks.length - processed) / rate / 60).toFixed(1)} 分钟)`
      );
    }
  }
  await flush();

  // 5. 失败清单
  if (failures.length > 0) {
    const dir = path.join(process.cwd(), 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'asset-vectors-failures.json');
    const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    writeFileSync(file, JSON.stringify([...prev, ...failures], null, 2));
    console.log(`[asset-vectors] 失败 ${failures.length} 条,清单追加至 ${file}`);
  }
  console.log(
    `[asset-vectors] 完成:成功 ${done} / 失败 ${failures.length} / 跳过 ${skipCount}` +
      `,耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`
  );
}

main().catch((e) => {
  console.error('[asset-vectors] 致命错误:', e);
  process.exit(1);
});

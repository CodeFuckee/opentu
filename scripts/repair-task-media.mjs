#!/usr/bin/env node
/**
 * 修复已完成图片任务的归档缺口：result.size=0 且 huabu bucket 缺少结果图的行。
 *
 * 背景：生成交付走上游 URL，归档是浏览器旁路 fire-and-forget（无重试、静默失败），
 * 上游抖动时 bucket 里没有副本，且所有完成路径硬编码 result.size=0（真值从未测量）。
 * 本脚本在服务端补齐：
 *   1. response_file_paths 为空 / 对象缺失 → 从 result.url（上游 URL，多尝试重试；
 *      data: URL 直接解码）重新下载 → sha256 → 上传 huabu；
 *   2. 回写 task_submissions：response_file_paths、result.size（真值）、
 *      result.source_url（保留原始 URL 便于调试）、result.repaired 标记。
 *
 * 不改动 result.url：存量任务在生成设备上已按旧 URL 渲染/缓存，服务端改写无益；
 * 「归档成功后替换 result.url」的新约定由前端归档链路（task-supabase-archive）负责。
 *
 * 用法（node >= 18，无需额外依赖）：
 *   SUPABASE_URL=http://10.37.80.25:8021 \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role key> \
 *   node scripts/repair-task-media.mjs            # dry-run：仅预览
 *   node scripts/repair-task-media.mjs --apply    # 实际下载/上传/回写
 *
 * 可选参数：
 *   --url <url>        覆盖 SUPABASE_URL
 *   --key <key>        覆盖 SUPABASE_SERVICE_ROLE_KEY
 *   --type <type>      任务类型，默认 image
 *   --limit <n>        本次最多处理多少行（默认 100，0 表示不限制）
 *   --task-id <id>     只处理指定任务（调试用，忽略 size 过滤）
 *
 * 安全说明：默认 dry-run；--apply 会下载上游文件并向 bucket/数据库写入。
 * 幂等：已带 result.repaired 标记且 size>0 的行会被跳过，可安全重跑。
 */
import { createHash } from 'node:crypto';

const ARGV = parseArgs(process.argv.slice(2));
const SUPABASE_URL = (ARGV.url || process.env.SUPABASE_URL || '').replace(
  /\/+$/,
  ''
);
const SERVICE_ROLE_KEY = ARGV.key || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TASK_TYPE = ARGV.type || 'image';
const LIMIT = Number(ARGV.limit ?? 100);
const APPLY = Boolean(ARGV.apply);
const FORCE = Boolean(ARGV.force);
const TARGET_TASK_ID = ARGV['task-id'] || '';

const BUCKET = 'huabu';
const DOWNLOAD_ATTEMPTS = 5;
const DOWNLOAD_BACKOFF_MS = (i) => Math.min(2 ** i * 3000, 20000);

if (!SUPABASE_URL) {
  fail('缺少 SUPABASE_URL（可用 --url 或环境变量 SUPABASE_URL 提供）');
}
if (!SERVICE_ROLE_KEY) {
  fail(
    '缺少 SUPABASE_SERVICE_ROLE_KEY（可用 --key 或环境变量提供；' +
      'service_role key 属于机密，仅存在于部署端，请向运维获取）'
  );
}

// ---------------------------------------------------------------------------
// 通用 HTTP 辅助
// ---------------------------------------------------------------------------

const HEADERS = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

/** 带 service_role 的通用请求；ok=false 时抛错。body 传对象自动序列化，传字符串视为已序列化 */
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const payload =
    body === undefined || typeof body === 'string'
      ? body
      : JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: { ...HEADERS, ...headers },
    body: payload,
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return res;
}

async function apiJson(path, opts) {
  const res = await api(path, opts);
  return res.json();
}

// ---------------------------------------------------------------------------
// 目标行收集
// ---------------------------------------------------------------------------

/** 拉取待修复行：终态 completed + result.size 为 0 或缺失（--task-id 时精确单个） */
async function collectTargetRows() {
  const select =
    'task_id,user_id,type,result,response_file_paths,completed_at,created_at';
  if (TARGET_TASK_ID) {
    const rows = await apiJson(
      `/rest/v1/task_submissions?select=${select}&task_id=eq.${encodeURIComponent(TARGET_TASK_ID)}`
    );
    return Array.isArray(rows) ? rows : [];
  }
  const sizeFilter = encodeURIComponent(
    '(result->>size.eq.0,result->>size.is.null)'
  );
  const rows = await apiJson(
    `/rest/v1/task_submissions?select=${select}` +
      `&status=eq.completed&type=eq.${encodeURIComponent(TASK_TYPE)}` +
      `&or=${sizeFilter}` +
      `&order=completed_at.desc.nullslast`
  );
  const list = Array.isArray(rows) ? rows : [];
  return LIMIT > 0 ? list.slice(0, LIMIT) : list;
}

// ---------------------------------------------------------------------------
// 下载 / 上传 / 校验
// ---------------------------------------------------------------------------

/** 魔数嗅探 mime（仅常见图片格式；无法识别返回 ''） */
function sniffMimeFromBytes(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  const ascii = (offset, text) =>
    bytes
      .slice(offset, offset + text.length)
      .every((b, i) => b === text.charCodeAt(i));
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    return 'image/webp';
  }
  return '';
}

function mimeToExtension(mime) {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 带重试的结果图下载（上游 URL 不稳定是常态）：
 * 响应必须为已知图片魔数或 image/* content-type，拒绝 HTML 错误页等毒化响应。
 */
async function downloadWithRetry(url) {
  let lastError = new Error('no attempt');
  for (let i = 0; i < DOWNLOAD_ATTEMPTS; i += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) repair-task-media/1.0',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty body');
      const sniffed = sniffMimeFromBytes(buf);
      const contentType = (res.headers.get('content-type') || '').split(';')[0];
      if (!sniffed && !contentType.startsWith('image/')) {
        throw new Error(`non-image content (sniff=${sniffed || 'unknown'}, ct=${contentType})`);
      }
      return { buf, mime: sniffed || contentType || 'image/png' };
    } catch (e) {
      lastError = e;
      if (i < DOWNLOAD_ATTEMPTS - 1) {
        await sleep(DOWNLOAD_BACKOFF_MS(i));
      }
    }
  }
  throw lastError;
}

/** data URL → { buf, mime }（b64 型结果无需网络下载） */
function decodeDataUrl(dataUrl) {
  const commaAt = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || commaAt < 0) {
    throw new Error('invalid data url');
  }
  const mime = dataUrl.slice(5, commaAt).split(';')[0] || 'application/octet-stream';
  const buf = Buffer.from(dataUrl.slice(commaAt + 1), 'base64');
  if (buf.length === 0) throw new Error('empty data url payload');
  return { buf, mime };
}

/** 上传到 huabu bucket（upsert，幂等）。二进制 body 直用原生 fetch，避免 JSON 序列化破坏 */
async function uploadToBucket(path, buf, mime) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encoded}`,
    {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': mime,
        'x-upsert': 'true',
      },
      body: buf,
    }
  );
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`upload ${path} -> ${res.status}: ${text}`);
  }
}

/** 读取 bucket 对象；失败返回 null（不抛错） */
async function readBucketObject(path) {
  try {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await api(`/storage/v1/object/${BUCKET}/${encoded}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 行级修复
// ---------------------------------------------------------------------------

/** 解析 bucket 目录用户名：user_profiles.oa_account 优先，邮箱 @ 前缀回退 */
async function resolveUsername(userId) {
  try {
    const rows = await apiJson(
      `/rest/v1/user_profiles?select=oa_account&user_id=eq.${userId}`
    );
    const oa = Array.isArray(rows) ? rows[0]?.oa_account : '';
    if (typeof oa === 'string' && oa.trim()) return sanitize(oa);
  } catch {
    // 查询失败走邮箱回退
  }
  try {
    const user = await apiJson(`/auth/v1/admin/users/${userId}`);
    const email = typeof user?.email === 'string' ? user.email : '';
    if (email.includes('@')) return sanitize(email.split('@')[0]);
  } catch {
    // 最终回退
  }
  return sanitize(`unknown-${userId.slice(0, 8)}`);
}

/** 与前端 sanitizeUsername 一致：小写 + [^a-z0-9._-] → _ */
function sanitize(username) {
  return username.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
}

/**
 * 修复单行：补齐 bucket 副本 + 回写 size/paths/标记。
 * 返回 { status: 'ok'|'skipped'|'failed', detail }
 */
async function repairRow(row, username) {
  const result = row.result || {};
  const existingPaths = Array.isArray(row.response_file_paths)
    ? row.response_file_paths
    : [];

  // 收集本次涉及的结果 URL（主图 + urls 数组，去重保序）
  const originalUrls = [...new Set(
    [typeof result.url === 'string' ? result.url : '']
      .concat(Array.isArray(result.urls) ? result.urls : [])
      .filter(Boolean)
  )];
  if (originalUrls.length === 0) {
    return { status: 'skipped', detail: 'result 无可下载 URL' };
  }
  if (
    !FORCE &&
    result.repaired &&
    Number(result.size) > 0
  ) {
    return { status: 'skipped', detail: '已修复过（result.repaired 存在）' };
  }

  // 1. 已有 bucket 副本 → 校验可读并取真值 size；缺失 → 重新下载上传
  const finalPaths = [];
  const bytesPerUrl = [];
  let missing = false;
  for (const path of existingPaths) {
    const buf = await readBucketObject(path);
    if (buf) {
      finalPaths.push(path);
      bytesPerUrl.push(buf.length);
    } else {
      missing = true;
    }
  }
  if (existingPaths.length === 0 || missing) {
    const dateStr = (row.completed_at || row.created_at || '').slice(0, 10) ||
      new Date().toISOString().slice(0, 10);
    for (const url of originalUrls) {
      let buf;
      let mime;
      if (url.startsWith('data:')) {
        ({ buf, mime } = decodeDataUrl(url));
      } else {
        ({ buf, mime } = await downloadWithRetry(url));
      }
      const hash = sha256Hex(buf);
      const ext = mimeToExtension(mime);
      const path = `${username}/${dateStr}/${hash}.${ext}`;
      if (APPLY) {
        await uploadToBucket(path, buf, mime);
      }
      finalPaths.push(path);
      bytesPerUrl.push(buf.length);
    }
  }

  const primarySize = bytesPerUrl[0] ?? 0;
  if (APPLY) {
    const nextResult = {
      ...result,
      size: primarySize,
      source_url: originalUrls[0],
      source_urls: originalUrls.length > 1 ? originalUrls : undefined,
      repaired: {
        at: new Date().toISOString(),
        via: 'repair-task-media.mjs',
        huabu_paths: finalPaths,
        bytes: bytesPerUrl,
      },
    };
    if (nextResult.source_urls === undefined) delete nextResult.source_urls;

    // return=representation 让 PostgREST 把更新后的行带回来：
    // [ok] 以「服务端回读确认 result.repaired 已写入」为准，而非 HTTP 状态码
    const patchRes = await api(
      `/rest/v1/task_submissions?task_id=eq.${encodeURIComponent(row.task_id)}` +
        `&user_id=eq.${row.user_id}` +
        `&select=task_id,response_file_paths,result`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: {
          response_file_paths: finalPaths,
          result: nextResult,
        },
      }
    );
    const patchedRows = await patchRes.json();
    if (!Array.isArray(patchedRows) || patchedRows.length === 0) {
      return {
        status: 'failed',
        detail: 'PATCH 未命中任何行（task_id/user_id 过滤无匹配？）',
      };
    }
    const patched = patchedRows[0];
    const patchedResult = patched?.result || {};
    if (
      !patchedResult.repaired ||
      Number(patchedResult.size) !== primarySize
    ) {
      return {
        status: 'failed',
        detail: `PATCH 回读校验失败：服务端返回 size=${patchedResult.size}，repaired=${!!patchedResult.repaired}`,
      };
    }
  }

  return {
    status: 'ok',
    detail: `paths=${finalPaths.length}（补下 ${finalPaths.length - existingPaths.length}） primaryBytes=${primarySize}${APPLY ? '（已回读确认）' : '（dry-run 未写入）'}`,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  log(`Supabase: ${SUPABASE_URL}`);
  log(`模式: ${APPLY ? 'APPLY（实际下载/上传/回写）' : 'DRY-RUN（仅预览）'}`);
  log(`任务类型: ${TASK_TYPE}${TARGET_TASK_ID ? `  指定任务: ${TARGET_TASK_ID}` : ''}`);
  log('');

  const rows = await collectTargetRows();
  if (rows.length === 0) {
    log('未找到待修复行（completed + size=0/缺失），无需处理。');
    return;
  }
  log(`发现 ${rows.length} 行待修复，开始逐行处理…`);

  const usernameCache = new Map();
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const label = `${row.task_id} (user=${row.user_id.slice(0, 8)}…)`;
    try {
      if (!usernameCache.has(row.user_id)) {
        usernameCache.set(row.user_id, await resolveUsername(row.user_id));
      }
      const r = await repairRow(row, usernameCache.get(row.user_id));
      if (r.status === 'ok') ok += 1;
      else skipped += 1;
      log(`  [${r.status}] ${label} — ${r.detail}`);
    } catch (e) {
      failed += 1;
      log(`  [failed] ${label} — ${e.message}`);
    }
    await sleep(200); // 轻微限速，避免打爆上游/存储
  }

  log('');
  log(
    `完成: 成功=${ok} 跳过=${skipped} 失败=${failed}` +
      (APPLY ? '' : '（dry-run，未写入任何数据）')
  );
  if (!APPLY && ok + skipped > 0) {
    log('确认无误后执行:  node scripts/repair-task-media.mjs --apply');
  }
  if (failed > 0) {
    log('存在失败行：多为上游 URL 已彻底失效；可稍后重跑（幂等），或依赖 reconcile-worker 的 tuzi 留存回传兜底。');
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, inline] = m;
    if (inline !== undefined) {
      out[key] = inline;
    } else if (key === 'apply' || key === 'force' || key === 'dry-run') {
      out[key] = true;
    } else {
      out[key] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`错误: ${msg}\n`);
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`执行失败: ${e.stack || e.message}\n`);
  process.exit(1);
});

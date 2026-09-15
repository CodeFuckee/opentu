/**
 * template-crawler Edge Function core logic (no Deno/npm dependency, unit-testable)
 *
 * 从建筑学长 community 网关同步 AI 模板到 ai_templates 表：
 *   列表(分页) → 增量判定(content_hash) → 详情(prompt) → 封面转存 huabu → upsert
 *
 * 上游鉴权算法（Phase 0 逆向验证，详见 openspec/changes/add-template-gallery/design.md）：
 *   sign      = MD5(params 按键名排序 "k=v"&连接 + "&key=d9fd3ec394").toUpperCase()
 *   timestamp = String(epochSec) + pad3((epochSec ^ 334) % 1000)   // 13位，不是毫秒
 *
 * index.ts 只负责 Deno.serve / 环境变量注入；本文件持有全部逻辑。
 */

// ==================== 常量 ====================

export const COMMUNITY_BASE = 'https://community.jianzhuxuezhang.com/cykj_community';
export const SIGN_SALT = 'd9fd3ec394';
export const TIMESTAMP_XOR = 334;
export const PRODUCT_ID = 51;
export const VERSION_CODE = 21714;
export const PRODUCT_TYPE = 'JZXZ';
export const SOURCE = 'jzxz';

export const DEFAULT_TEMPLATE_TYPES = ['BANANA_CASE'];
export const DEFAULT_MAX_PAGES = 3;
export const DEFAULT_PAGE_SIZE = 30;
/** 页间控速（毫秒）：配合 edge-runtime 墙钟放宽（15 分钟），等待不耗 CPU */
export const PAGE_DELAY_MS = 2000;
export const DETAIL_DELAY_MS = 300;
export const MAX_PAGES_HARD_CAP = 30;

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};

export interface TemplateCrawlerDeps {
  /** Injected HTTP client for testing; defaults to global fetch */
  fetch?: typeof fetch;
  /** 注入 sleep 便于测试（毫秒）；默认真实 setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

export interface TemplateCrawlerEnv {
  SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  /** 公网可达地址（容器内 SUPABASE_URL 指向内部网关 api-gw，公开 URL 必须用它） */
  SUPABASE_PUBLIC_URL?: string;
}

// ==================== MD5（纯 TS，供 Deno 与 node:test 共用） ====================

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}

function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** 标准 MD5，输出小写十六进制 */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const origLen = bytes.length;
  const bitLenLo = (origLen << 3) >>> 0;
  const bitLenHi = Math.floor(origLen / 536870912) >>> 0; // origLen*8 / 2^32
  const paddedLen = (((origLen + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[origLen] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLenLo, true);
  dv.setUint32(paddedLen - 4, bitLenHi, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let chunk = 0; chunk < paddedLen; chunk += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(chunk + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      const newB = (B + rotl(F, MD5_SHIFTS[i])) >>> 0;
      A = D; D = C; C = B; B = newB;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true); out.setUint32(4, b0, true);
  out.setUint32(8, c0, true); out.setUint32(12, d0, true);
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(out.getUint8(i).toString(16).padStart(2, '0'));
  return hex.join('');
}

// ==================== 上游鉴权算法（逆向验证见 design.md 附录） ====================

/** sign = MD5(排序参数 "k=v"&连接(空值跳过/trim) + "&key=盐").toUpperCase() */
export function computeSign(
  params: Record<string, string | number>,
  salt: string = SIGN_SALT
): string {
  const entries = Object.keys(params)
    .sort()
    .filter((k) => {
      const v = params[k];
      return v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== 'null';
    })
    .map((k) => `${k}=${String(params[k]).trim()}`);
  const B = entries.join('&') + '&key=' + salt;
  return md5(B).toUpperCase();
}

/** timestamp 头：秒级时间戳 + 3 位异或校验码（(epochSec ^ 334) % 1000 补零） */
export function computeHeaderTimestamp(overscan = 0, now = Date.now()): string {
  const epochSec = Math.floor((now + overscan) / 1000);
  let checksum = String((epochSec ^ TIMESTAMP_XOR) % 1000);
  if (checksum.length === 1) checksum = '00' + checksum;
  if (checksum.length === 2) checksum = '0' + checksum;
  return String(epochSec) + checksum;
}

function upstreamHeaders(): Record<string, string> {
  return {
    'Product-Type': PRODUCT_TYPE,
    lang: 'zh-CN',
    timestamp: computeHeaderTimestamp(),
    Accept: 'application/json, text/plain, */*',
  };
}

// ==================== 上游 URL 与数据映射 ====================

export function buildListUrl(
  templateType: string,
  pageNum: number,
  pageSize: number
): string {
  const params: Record<string, string | number> = {
    product_id: PRODUCT_ID,
    version_code: VERSION_CODE,
    pageNum,
    pageSize,
    templateType,
    productType: PRODUCT_TYPE,
  };
  const sign = computeSign(params);
  const qs = Object.entries({ ...params, sign }).map(([k, v]) => `${k}=${v}`).join('&');
  return `${COMMUNITY_BASE}/templates?${qs}`;
}

export function buildDetailUrl(templateId: string): string {
  return `${COMMUNITY_BASE}/templates/${templateId}`;
}

export interface UpstreamListRow {
  title?: string;
  templateId?: string;
  templateVersion?: string;
  coverUrl?: string;
  width?: number;
  height?: number;
  useCount?: number;
  viewCount?: number;
  collectCount?: number;
  createdDate?: number;
}

export interface UpstreamDetail {
  title?: string;
  templateId?: string;
  templateVersion?: string;
  coverUrl?: string;
  catalogs?: string[][];
  content?: {
    prompt?: string;
    resolution?: string;
    aspectRatio?: string;
    generateImage?: string;
    baseImageList?: unknown[];
  };
}

/** 详情响应 → ai_templates 行字段（不含 id/时间戳） */
export function mapDetailToRow(
  detail: UpstreamDetail,
  listRow?: UpstreamListRow
): Record<string, unknown> {
  const catalogs = Array.isArray(detail.catalogs) ? detail.catalogs : [];
  const category = catalogs[0]?.[0] ?? null;
  const coverUrl = detail.coverUrl ?? listRow?.coverUrl ?? null;
  const content = detail.content ?? {};
  const extra = {
    resolution: content.resolution ?? null,
    aspectRatio: content.aspectRatio ?? null,
    generateImage: content.generateImage ?? null,
    width: listRow?.width ?? null,
    height: listRow?.height ?? null,
  };
  return {
    source: SOURCE,
    source_id: detail.templateId ?? listRow?.templateId ?? '',
    category,
    catalogs,
    title: detail.title ?? listRow?.title ?? '',
    prompt: content.prompt ?? null,
    template_version: detail.templateVersion ?? listRow?.templateVersion ?? null,
    source_url: coverUrl,
    extra,
    likes: listRow?.collectCount ?? 0,
    views: listRow?.viewCount ?? 0,
    source_use_count: listRow?.useCount ?? 0,
  };
}

/** 内容哈希：用于增量判定（仅计入易变业务字段） */
export function contentHashOf(row: Record<string, unknown>): string {
  const material = JSON.stringify({
    title: row.title,
    prompt: row.prompt,
    category: row.category,
    catalogs: row.catalogs,
    cover: row.source_url,
    likes: row.likes,
    views: row.views,
    template_version: row.template_version,
  });
  return md5(material);
}

// ==================== 通用工具 ====================

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractBearerToken(headerValue: string | null): string | null {
  const match = (headerValue || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function fetchJson(
  url: string,
  deps: TemplateCrawlerDeps
): Promise<unknown> {
  const doFetch = deps.fetch || fetch;
  const response = await doFetch(url, { method: 'GET', headers: upstreamHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`upstream ${response.status} ${url.slice(0, 120)} ${body.slice(0, 200)}`);
  }
  return response.json();
}

async function verifyCallerJwt(
  supabaseUrl: string,
  serviceRoleKey: string,
  jwt: string,
  deps: TemplateCrawlerDeps
): Promise<{ id: string; email: string | null } | null> {
  const doFetch = deps.fetch || fetch;
  try {
    const response = await doFetch(
      `${(supabaseUrl || '').replace(/\/$/, '')}/auth/v1/user`,
      { method: 'GET', headers: { apikey: serviceRoleKey, Authorization: `Bearer ${jwt}` } }
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { id?: unknown; email?: unknown };
    if (typeof payload?.id !== 'string') return null;
    return {
      id: payload.id,
      email: typeof payload.email === 'string' ? payload.email : null,
    };
  } catch {
    return null;
  }
}

/**
 * 管理员判定：configs 表 TEMPLATE_CRAWLER_ADMINS 键（逗号分隔 oa 账号，即邮箱前缀）。
 * department_configs 表在本库未部署（ai-proxy 对其容错回退），故复用 configs。
 */
export const ADMINS_CONFIG_KEY = 'TEMPLATE_CRAWLER_ADMINS';

export async function isAdminCaller(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string | null,
  deps: TemplateCrawlerDeps
): Promise<boolean> {
  if (!email || !email.includes('@')) return false;
  const oaAccount = email.split('@')[0].toLowerCase();
  const doFetch = deps.fetch || fetch;
  try {
    const response = await doFetch(
      `${(supabaseUrl || '').replace(/\/$/, '')}/rest/v1/configs?select=value&key=eq.${ADMINS_CONFIG_KEY}`,
      {
        method: 'GET',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Accept: 'application/json',
        },
      }
    );
    if (!response.ok) return false;
    const rows = (await response.json()) as Array<{ value?: string }>;
    const raw = Array.isArray(rows) && rows[0]?.value ? rows[0].value : '';
    return raw
      .split(',')
      .map((it) => it.trim().toLowerCase())
      .filter(Boolean)
      .includes(oaAccount);
  } catch {
    return false;
  }
}

// ==================== 同步流程 ====================

export interface CrawlOptions {
  templateTypes?: string[];
  maxPages?: number;
  pageSize?: number;
  pageDelayMs?: number;
  detailDelayMs?: number;
  withCovers?: boolean;
  /** 强制重爬：忽略 content_hash 增量判定（用于回填/重试封面等） */
  force?: boolean;
}

export interface CrawlSummary {
  templateTypes: string[];
  totalListed: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  coverUploaded: number;
  errors: string[];
}

export interface TemplateCrawlerServiceEnv {
  SERVICE_ROLE_KEY: string;
  SUPABASE_URL: string;
  /** 公网可达地址：构建封面公开 URL 用（缺省回退 SUPABASE_URL） */
  PUBLIC_BASE_URL: string;
}

function serviceHeaders(env: TemplateCrawlerServiceEnv): Record<string, string> {
  return {
    apikey: env.SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Prefer: 'resolution=merge-duplicates',
  };
}

async function postgrestUpsert(
  env: TemplateCrawlerServiceEnv,
  row: Record<string, unknown>,
  deps: TemplateCrawlerDeps
): Promise<void> {
  const doFetch = deps.fetch || fetch;
  const url = `${(env.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1/ai_templates?on_conflict=source,source_id`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: serviceHeaders(env),
    body: JSON.stringify([row]),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`upsert failed ${response.status} ${body.slice(0, 200)}`);
  }
}

async function fetchExistingHash(
  env: TemplateCrawlerServiceEnv,
  sourceId: string,
  deps: TemplateCrawlerDeps
): Promise<string | null> {
  const doFetch = deps.fetch || fetch;
  const url = `${(env.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1/ai_templates?select=content_hash&source=eq.${SOURCE}&source_id=eq.${sourceId}`;
  const response = await doFetch(url, {
    method: 'GET',
    headers: serviceHeaders(env),
  });
  if (!response.ok) return null;
  const rows = (await response.json()) as Array<{ content_hash?: string }>;
  return Array.isArray(rows) && rows[0]?.content_hash ? rows[0].content_hash : null;
}

/** 封面转存公开桶 images（公开读策略现成，前端直接用 getPublicUrl 直链）；失败静默 */
async function uploadCover(
  env: TemplateCrawlerServiceEnv,
  templateId: string,
  coverUrl: string,
  deps: TemplateCrawlerDeps
): Promise<{ path: string; publicUrl: string } | null> {
  const doFetch = deps.fetch || fetch;
  const extMatch = coverUrl.split('?')[0].match(/\.(png|jpe?g|webp|gif)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const path = `templates/${SOURCE}/${templateId}-cover.${ext}`;
  const base = (env.PUBLIC_BASE_URL || env.SUPABASE_URL || '').replace(/\/$/, '');
  try {
    const response = await doFetch(coverUrl, { method: 'GET' });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const uploadUrl = `${base}/storage/v1/object/images/${path}`;
    const upload = await doFetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: env.SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`,
        'Content-Type': mime,
        'x-upsert': 'true',
      },
      body: buffer,
    });
    if (!upload.ok) return null;
    return { path, publicUrl: `${base}/storage/v1/object/public/images/${path}` };
  } catch {
    return null;
  }
}

/**
 * 同步一个 templateType 的分页列表 + 详情 + 入库。
 * 独立暴露便于单测聚合流程。
 */
export async function syncTemplateType(
  env: TemplateCrawlerServiceEnv,
  deps: TemplateCrawlerDeps,
  templateType: string,
  options: Required<Pick<CrawlOptions, 'maxPages' | 'pageSize' | 'pageDelayMs' | 'detailDelayMs' | 'withCovers'>>
): Promise<CrawlSummary> {
  const summary: CrawlSummary = {
    templateTypes: [templateType],
    totalListed: 0, inserted: 0, updated: 0, skipped: 0, failed: 0,
    coverUploaded: 0, errors: [],
  };

  for (let pageNum = 0; pageNum < options.maxPages; pageNum++) {
    let listRows: UpstreamListRow[];
    try {
      listRows = (await fetchJson(buildListUrl(templateType, pageNum, options.pageSize), deps)) as UpstreamListRow[];
    } catch (error) {
      summary.errors.push(`list p${pageNum}: ${error instanceof Error ? error.message : error}`);
      break;
    }
    if (!Array.isArray(listRows) || listRows.length === 0) break;
    summary.totalListed += listRows.length;

    for (const listRow of listRows) {
      const sourceId = listRow.templateId;
      if (!sourceId) { summary.skipped++; continue; }

      // 增量：先以列表字段预判；详情后才得完整哈希，故此处只跳过确定无变化的
      let detail: UpstreamDetail;
      try {
        detail = (await fetchJson(buildDetailUrl(sourceId), deps)) as UpstreamDetail;
      } catch (error) {
        summary.failed++;
        summary.errors.push(`detail ${sourceId}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      await (deps.sleep || defaultSleep)(options.detailDelayMs);

      const row = mapDetailToRow(detail, listRow);
      row.content_hash = contentHashOf(row);

      const existingHash = await fetchExistingHash(env, sourceId, deps);
      if (!options.force && existingHash && existingHash === row.content_hash) {
        summary.skipped++;
        continue;
      }

      try {
        if (options.withCovers && row.source_url) {
          const cover = await uploadCover(env, sourceId, row.source_url as string, deps);
          if (cover) {
            row.cover_storage_path = cover.path;
            row.cover_public_url = cover.publicUrl;
            summary.coverUploaded++;
          }
        }
        await postgrestUpsert(env, row, deps);
        if (existingHash) summary.updated++; else summary.inserted++;
      } catch (error) {
        summary.failed++;
        summary.errors.push(`upsert ${sourceId}: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (pageNum < options.maxPages - 1) {
      await (deps.sleep || defaultSleep)(options.pageDelayMs);
    }
  }
  return summary;
}

/** 统计信息（GET /stats 或 POST action=stats） */
export async function crawlStats(
  env: TemplateCrawlerServiceEnv,
  deps: TemplateCrawlerDeps
): Promise<Record<string, unknown>> {
  const doFetch = deps.fetch || fetch;
  const url = `${(env.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1/ai_templates?select=status,category&source=eq.${SOURCE}`;
  const response = await doFetch(url, { method: 'GET', headers: serviceHeaders(env) });
  if (!response.ok) {
    throw new Error(`stats query failed ${response.status}`);
  }
  const rows = (await response.json()) as Array<{ status: string; category: string | null }>;
  const byCategory: Record<string, number> = {};
  let active = 0, hidden = 0;
  for (const row of rows) {
    if (row.status === 'active') active++; else hidden++;
    const cat = row.category || '未分类';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  return { source: SOURCE, total: rows.length, active, hidden, byCategory };
}

// ==================== 请求处理 ====================

/** Handles one template-crawler request (used by index.ts and tests) */
export async function handleTemplateCrawler(
  request: Request,
  env: TemplateCrawlerEnv,
  deps: TemplateCrawlerDeps = {}
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const serviceRoleKey = env.SERVICE_ROLE_KEY || '';
  const supabaseUrl = env.SUPABASE_URL || '';
  if (!serviceRoleKey || !supabaseUrl) {
    return jsonResponse(500, { error: 'SERVICE_ROLE_KEY / SUPABASE_URL is not configured' });
  }

  const jwt = extractBearerToken(request.headers.get('Authorization'));
  if (!jwt) {
    return jsonResponse(401, { error: 'unauthorized: missing bearer token' });
  }
  const caller = await verifyCallerJwt(supabaseUrl, serviceRoleKey, jwt, deps);
  if (!caller) {
    return jsonResponse(401, { error: 'unauthorized: invalid token' });
  }
  if (!(await isAdminCaller(supabaseUrl, serviceRoleKey, caller.email, deps))) {
    return jsonResponse(403, { error: 'forbidden: admin only' });
  }

  let body: {
    action?: string;
    templateTypes?: unknown;
    maxPages?: unknown;
    pageSize?: unknown;
    withCovers?: unknown;
    force?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const action = typeof body.action === 'string' ? body.action : 'crawl';
  const publicBase = (env.SUPABASE_PUBLIC_URL || supabaseUrl || '').replace(/\/$/, '');
  const serviceEnv: TemplateCrawlerServiceEnv = {
    SERVICE_ROLE_KEY: serviceRoleKey,
    SUPABASE_URL: supabaseUrl,
    PUBLIC_BASE_URL: publicBase,
  };

  try {
    if (action === 'stats') {
      const stats = await crawlStats(serviceEnv, deps);
      return jsonResponse(200, stats);
    }

    const templateTypes = Array.isArray(body.templateTypes) && body.templateTypes.every((t) => typeof t === 'string')
      ? (body.templateTypes as string[])
      : DEFAULT_TEMPLATE_TYPES;
    const maxPages = clampInt(body.maxPages, 1, MAX_PAGES_HARD_CAP, DEFAULT_MAX_PAGES);
    const pageSize = clampInt(body.pageSize, 1, 50, DEFAULT_PAGE_SIZE);
    const withCovers = body.withCovers !== false;

    const summaries: CrawlSummary[] = [];
    for (const templateType of templateTypes) {
      summaries.push(
        await syncTemplateType(serviceEnv, deps, templateType, {
          maxPages, pageSize, pageDelayMs: PAGE_DELAY_MS, detailDelayMs: DETAIL_DELAY_MS, withCovers,
          force: body.force === true,
        })
      );
    }
    const total = summaries.reduce(
      (acc, s) => ({
        totalListed: acc.totalListed + s.totalListed,
        inserted: acc.inserted + s.inserted,
        updated: acc.updated + s.updated,
        skipped: acc.skipped + s.skipped,
        failed: acc.failed + s.failed,
        coverUploaded: acc.coverUploaded + s.coverUploaded,
      }),
      { totalListed: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, coverUploaded: 0 }
    );
    const errors = summaries.flatMap((s) => s.errors);
    return jsonResponse(200, {
      action: 'crawl',
      templateTypes,
      total,
      byType: summaries.map((s) => ({ templateType: s.templateTypes[0], totalListed: s.totalListed })),
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return jsonResponse(500, { error: message });
  }
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

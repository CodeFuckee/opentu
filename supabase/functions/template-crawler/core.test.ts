/**
 * template-crawler Edge Function unit tests (node:test)
 *
 * 覆盖：上游签名/时间戳算法（与真实抓包值逐位比对）、详情映射、增量判定、
 * 同步编排（mock fetch 全链路）、管理员鉴权分支。
 *
 * Run: node --test supabase/functions/template-crawler/core.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDetailUrl,
  buildListUrl,
  computeHeaderTimestamp,
  computeSign,
  contentHashOf,
  handleTemplateCrawler,
  mapDetailToRow,
  md5,
  syncTemplateType,
} from './core.ts';

// ==================== 算法正确性（真实抓包值对照） ====================

describe('md5 / computeSign / computeHeaderTimestamp（逆向算法，抓包对照）', () => {
  test('md5 标准测试向量', () => {
    assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
    assert.equal(
      md5('The quick brown fox jumps over the lazy dog'),
      '9e107d9d372bb6826bd81d3542a419d6'
    );
  });

  test('sign 与真实抓包值逐位一致', () => {
    const sign = computeSign({
      product_id: 51,
      version_code: 21714,
      pageNum: 0,
      pageSize: 30,
      templateType: 'BANANA_CASE',
      productType: 'JZXZ',
    });
    assert.equal(sign, 'C57A592A24AB93E9A39BE8F92ED664F2');
  });

  test('timestamp 头为秒+3位异或校验码（13位，非毫秒）', () => {
    const ts = computeHeaderTimestamp(0, 1789453285971 - 971 + 971); // 直接用捕获时刻附近
    assert.equal(ts.length, 13);
    const epochSec = Number(ts.slice(0, 10));
    const checksum = ts.slice(10);
    assert.equal(checksum, String((epochSec ^ 334) % 1000).padStart(3, '0'));
  });

  test('timestamp 用真实抓包时刻复算校验位 971', () => {
    // 抓包值 1789453285971：秒=1789453285，校验=(1789453285^334)%1000=971
    const ts = computeHeaderTimestamp(0, 1789453285000);
    assert.equal(ts, '1789453285971');
  });

  test('buildListUrl 包含正确 sign 与参数', () => {
    const url = buildListUrl('BANANA_CASE', 0, 30);
    assert.ok(url.startsWith('https://community.jianzhuxuezhang.com/cykj_community/templates?'));
    assert.ok(url.includes('pageNum=0'));
    assert.ok(url.includes('sign=C57A592A24AB93E9A39BE8F92ED664F2'));
    assert.equal(buildDetailUrl('6aa8'), 'https://community.jianzhuxuezhang.com/cykj_community/templates/6aa8');
  });
});

// ==================== 详情映射与增量哈希 ====================

const DETAIL_FIXTURE = {
  title: '中式景观渲染',
  templateId: '6aa8c6a367bd506400d8ee2e',
  templateVersion: 'GPT_IMAGE_2',
  coverUrl: 'https://image-assets.soutushenqi.com/jzxz_plugin_cover/1789445783142_azfn.png',
  catalogs: [['效果渲染', '景观渲染']],
  content: {
    aspectRatio: 'auto',
    baseImageList: [],
    resolution: '1k',
    generateImage: 'https://image-assets.soutushenqi.com/jzxz_plugin_cover/1789445783142_azfn.png',
    prompt: '"imageType": "新中式景观实景照片"',
  },
};

const LIST_FIXTURE = {
  title: '中式景观渲染',
  templateId: '6aa8c6a367bd506400d8ee2e',
  coverUrl: DETAIL_FIXTURE.coverUrl,
  width: 613,
  height: 407,
  useCount: 0,
  viewCount: 8,
  collectCount: 0,
};

describe('mapDetailToRow / contentHashOf', () => {
  test('详情映射提取分类、prompt、计数与 extra', () => {
    const row = mapDetailToRow(DETAIL_FIXTURE, LIST_FIXTURE);
    assert.equal(row.source, 'jzxz');
    assert.equal(row.source_id, '6aa8c6a367bd506400d8ee2e');
    assert.equal(row.category, '效果渲染');
    assert.deepEqual(row.catalogs, [['效果渲染', '景观渲染']]);
    assert.equal(row.prompt, '"imageType": "新中式景观实景照片"');
    assert.equal(row.views, 8);
    assert.equal(row.template_version, 'GPT_IMAGE_2');
    assert.equal((row.extra as any).resolution, '1k');
  });

  test('content_hash 对 prompt 变化敏感、对无关字段不敏感', () => {
    const a = mapDetailToRow(DETAIL_FIXTURE, LIST_FIXTURE);
    const b = mapDetailToRow(DETAIL_FIXTURE, LIST_FIXTURE);
    assert.equal(contentHashOf(a), contentHashOf(b));
    const changed = { ...DETAIL_FIXTURE, content: { ...DETAIL_FIXTURE.content, prompt: '变化后的提示词' } };
    assert.notEqual(contentHashOf(mapDetailToRow(changed, LIST_FIXTURE)), contentHashOf(a));
  });
});

// ==================== 同步编排 ====================

function buildEnv() {
  return { SERVICE_ROLE_KEY: 'srv-key', SUPABASE_URL: 'http://api-gw:8000' };
}

type Capture = { url: string; init?: RequestInit };

function routerFetch(routes: Array<{ match: RegExp; handler: (url: string) => { status: number; body: string } }>, captures: Capture[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    captures.push({ url, init });
    for (const route of routes) {
      if (route.match.test(url)) {
        const { status, body } = route.handler(url);
        return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('unexpected ' + url.slice(0, 120), { status: 404 });
  };
}

function adminRoutes(admins = 'chenkaidi') {
  return [
    { match: /\/auth\/v1\/user/, handler: () => ({ status: 200, body: JSON.stringify({ id: 'u1', email: 'chenkaidi@example.com' }) }) },
    { match: /configs\?select=value/, handler: () => ({ status: 200, body: JSON.stringify([{ value: admins }]) }) },
  ];
}

const noSleep = async () => {};

describe('syncTemplateType', () => {
  test('全量入库：列表→详情→转存→upsert 计入 inserted', async () => {
    const captures: Capture[] = [];
    const env = buildEnv();
    const fetchImpl = routerFetch(
      [
        ...adminRoutes(),
        { match: /\/templates\?/, handler: () => ({ status: 200, body: JSON.stringify([LIST_FIXTURE]) }) },
        { match: /\/templates\/6aa8/, handler: () => ({ status: 200, body: JSON.stringify(DETAIL_FIXTURE) }) },
        { match: /ai_templates\?select=content_hash/, handler: () => ({ status: 200, body: '[]' }) },
        { match: /image-assets\.soutushenqi\.com/, handler: () => ({ status: 200, body: 'fake-image-bytes' }) },
        { match: /storage\/v1\/object\/images\//, handler: () => ({ status: 200, body: '{"Key":"x"}' }) },
        { match: /ai_templates\?on_conflict=/, handler: () => ({ status: 201, body: '[]' }) },
      ],
      captures
    );
    const summary = await syncTemplateType(
      env, { fetch: fetchImpl, sleep: noSleep }, 'BANANA_CASE',
      { maxPages: 1, pageSize: 30, pageDelayMs: 0, detailDelayMs: 0, withCovers: true }
    );
    assert.equal(summary.totalListed, 1);
    assert.equal(summary.inserted, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.coverUploaded, 1);
    assert.equal(summary.errors.length, 0);
    // upsert 请求体包含映射后的行与转存路径
    const upsert = captures.find((c) => c.url.includes('on_conflict='));
    assert.ok(upsert, '应有 upsert 请求');
    const body = JSON.parse(String(upsert.init?.body))[0];
    assert.equal(body.source_id, '6aa8c6a367bd506400d8ee2e');
    assert.ok(String(body.cover_storage_path).startsWith('templates/jzxz/'));
    assert.ok(body.prompt.includes('新中式景观实景照片'));
  });

  test('content_hash 未变化时跳过（不请求 upsert）', async () => {
    const row = mapDetailToRow(DETAIL_FIXTURE, LIST_FIXTURE);
    const existingHash = contentHashOf(row);
    const captures: Capture[] = [];
    const env = buildEnv();
    const fetchImpl = routerFetch(
      [
        ...adminRoutes(),
        { match: /\/templates\?/, handler: () => ({ status: 200, body: JSON.stringify([LIST_FIXTURE]) }) },
        { match: /\/templates\/6aa8/, handler: () => ({ status: 200, body: JSON.stringify(DETAIL_FIXTURE) }) },
        { match: /ai_templates\?select=content_hash/, handler: () => ({ status: 200, body: JSON.stringify([{ content_hash: existingHash }]) }) },
      ],
      captures
    );
    const summary = await syncTemplateType(
      env, { fetch: fetchImpl, sleep: noSleep }, 'BANANA_CASE',
      { maxPages: 1, pageSize: 30, pageDelayMs: 0, detailDelayMs: 0, withCovers: false }
    );
    assert.equal(summary.skipped, 1);
    assert.equal(summary.inserted, 0);
    assert.equal(summary.updated, 0);
    assert.ok(!captures.some((c) => c.url.includes('on_conflict=')), '不应有 upsert 请求');
  });

  test('上游列表失败：计入 errors 且不抛出', async () => {
    const env = buildEnv();
    const fetchImpl = routerFetch(
      [
        ...adminRoutes(),
        { match: /\/templates\?/, handler: () => ({ status: 500, body: '{"error":"boom"}' }) },
      ],
      []
    );
    const summary = await syncTemplateType(
      env, { fetch: fetchImpl, sleep: noSleep }, 'BANANA_CASE',
      { maxPages: 1, pageSize: 30, pageDelayMs: 0, detailDelayMs: 0, withCovers: false }
    );
    assert.equal(summary.totalListed, 0);
    assert.equal(summary.errors.length, 1);
  });
});

// ==================== 请求处理与鉴权 ====================

describe('handleTemplateCrawler', () => {
  const env = buildEnv();

  test('OPTIONS 预检 204', async () => {
    const res = await handleTemplateCrawler(
      new Request('http://x/functions/v1/template-crawler', { method: 'OPTIONS' }), env
    );
    assert.equal(res.status, 204);
  });

  test('缺少 token 401；无效 token 401', async () => {
    const noToken = await handleTemplateCrawler(
      new Request('http://x/f', { method: 'POST' }), env
    );
    assert.equal(noToken.status, 401);
    const badToken = await handleTemplateCrawler(
      new Request('http://x/f', { method: 'POST', headers: { Authorization: 'Bearer bad' } }),
      env,
      { fetch: routerFetch([{ match: /\/auth\/v1\/user/, handler: () => ({ status: 401, body: '{}' }) }], []) }
    );
    assert.equal(badToken.status, 401);
  });

  test('非管理员 403，不产生上游抓取请求', async () => {
    const captures: Capture[] = [];
    const res = await handleTemplateCrawler(
      new Request('http://x/f', { method: 'POST', headers: { Authorization: 'Bearer ok' }, body: JSON.stringify({ action: 'crawl' }) }),
      env,
      { fetch: routerFetch([...adminRoutes('someone-else'), { match: /templates/, handler: () => ({ status: 200, body: '[]' }) }], captures) }
    );
    assert.equal(res.status, 403);
    assert.ok(!captures.some((c) => c.url.includes('/templates?')), '不应有上游列表请求');
  });

  test('管理员 stats 动作返回分类统计', async () => {
    const res = await handleTemplateCrawler(
      new Request('http://x/f', { method: 'POST', headers: { Authorization: 'Bearer ok' }, body: JSON.stringify({ action: 'stats' }) }),
      env,
      {
        fetch: routerFetch(
          [
            ...adminRoutes(),
            { match: /ai_templates\?select=status,category/, handler: () => ({ status: 200, body: JSON.stringify([{ status: 'active', category: '效果渲染' }, { status: 'hidden', category: '效果渲染' }]) }) },
          ],
          []
        ),
      }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { active: number; hidden: number; byCategory: Record<string, number> };
    assert.equal(body.active, 1);
    assert.equal(body.hidden, 1);
    assert.equal(body.byCategory['效果渲染'], 2);
  });
});

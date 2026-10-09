/**
 * 模板中心数据访问层单测：用链式 mock Supabase 客户端锁定查询形态
 * （status 过滤、排序键 + id tiebreaker、分页窗口、分类/搜索过滤、RPC 调用）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  configureTemplateGallery,
  getTemplateGalleryConfig,
} from './runtime';
import {
  countTemplates,
  listTemplates,
  listTemplateCategories,
  normalizeTemplateCoverUrl,
  recordTemplateUsage,
} from './template-service';

interface RecordedQuery {
  table: string;
  select?: string;
  selectOpts?: { count?: string; head?: boolean };
  filters: Array<{ op: string; args: unknown[] }>;
  orders: Array<{ column: string; ascending: boolean }>;
  range?: [number, number];
}

/** 可 await 的链式 builder：记录调用形态，then 时返回固定结果 */
function makeBuilder(
  table: string,
  data: unknown,
  error: unknown = null,
  count: number | null = null
) {
  const query: RecordedQuery = { table, filters: [], orders: [] };
  const chain: Record<string, unknown> = {
    select: (s: string, opts?: { count?: string; head?: boolean }) => {
      query.select = s;
      query.selectOpts = opts;
      return chain;
    },
    eq: (...args: unknown[]) => {
      query.filters.push({ op: 'eq', args });
      return chain;
    },
    not: (...args: unknown[]) => {
      query.filters.push({ op: 'not', args });
      return chain;
    },
    ilike: (...args: unknown[]) => {
      query.filters.push({ op: 'ilike', args });
      return chain;
    },
    order: (column: string, opts: { ascending: boolean }) => {
      query.orders.push({ column, ascending: opts?.ascending ?? true });
      return chain;
    },
    range: (from: number, to: number) => {
      query.range = [from, to];
      return chain;
    },
    // supabase-js 的 builder 恒以 { data, error, count } resolve，不 reject
    then: (resolve: (v: { data: unknown; error: unknown; count: number | null }) => void) =>
      resolve({ data, error, count }),
  };
  return { chain, query };
}

function makeClient(data: unknown, error: unknown = null, count: number | null = null) {
  const queries: RecordedQuery[] = [];
  const client = {
    from: (table: string) => {
      const b = makeBuilder(table, data, error, count);
      queries.push(b.query);
      return b.chain;
    },
    rpc: async (fn: string, args: unknown) => ({ data: 7, error: null, fn, args }),
  };
  return { client, queries };
}

describe('template-service 查询形态', () => {
  beforeEach(() => {
    configureTemplateGallery(null);
  });

  it('未注册客户端时抛「模板中心未初始化」', async () => {
    await expect(listTemplates()).rejects.toThrow(/未初始化/);
    expect(getTemplateGalleryConfig()).toBeNull();
  });

  it('listTemplates：status=active + 热度主排序键 desc + 新增时间/id 兜底 + 首页窗口', async () => {
    const { client, queries } = makeClient([]);
    configureTemplateGallery({ client: client as never });
    const rows = await listTemplates({ sort: 'hot', limit: 30 });
    expect(rows).toEqual([]);
    const q = queries[0];
    expect(q.table).toBe('ai_templates');
    expect(q.filters).toContainEqual({
      op: 'eq',
      args: ['status', 'active'],
    });
    expect(q.orders).toEqual([
      { column: 'usage_count', ascending: false },
      { column: 'crawled_at', ascending: false },
      { column: 'id', ascending: true },
    ]);
    expect(q.range).toEqual([0, 29]);
  });

  it('listTemplates：latest 排序按 crawled_at；分类与搜索过滤正确', async () => {
    const { client, queries } = makeClient([]);
    configureTemplateGallery({ client: client as never });
    await listTemplates({
      sort: 'latest',
      category: '效果渲染',
      search: ' 景观 ',
      limit: 15,
      offset: 30,
    });
    const q = queries[0];
    expect(q.orders[0]).toEqual({ column: 'crawled_at', ascending: false });
    expect(q.range).toEqual([30, 44]);
    expect(q.filters).toContainEqual({ op: 'eq', args: ['category', '效果渲染'] });
    expect(q.filters).toContainEqual({ op: 'ilike', args: ['title', '%景观%'] });
  });

  it('listTemplateCategories：只取 category 列、排除 null、按出现顺序去重', async () => {
    const { client, queries } = makeClient([
      { category: '效果渲染' },
      { category: '效果渲染' },
      { category: null },
      { category: '平面设计' },
    ]);
    configureTemplateGallery({ client: client as never });
    const cats = await listTemplateCategories();
    expect(cats).toEqual(['效果渲染', '平面设计']);
    expect(queries[0].select).toBe('category');
    expect(queries[0].filters).toContainEqual({
      op: 'eq',
      args: ['status', 'active'],
    });
  });

  it('recordTemplateUsage：调用 use_template RPC 并返回计数', async () => {
    const { client } = makeClient([]);
    configureTemplateGallery({ client: client as never });
    await expect(
      recordTemplateUsage('6aa8c6a3-67bd-5064-00d8-ee2e00000000')
    ).resolves.toBe(7);
  });

  it('countTemplates：head + exact count 请求，返回总数并带筛选', async () => {
    const { client, queries } = makeClient(null, null, 1291);
    configureTemplateGallery({ client: client as never });
    await expect(
      countTemplates({ category: '效果渲染', search: ' 景观 ' })
    ).resolves.toBe(1291);
    const q = queries[0];
    expect(q.selectOpts).toEqual({ count: 'exact', head: true });
    expect(q.filters).toContainEqual({ op: 'eq', args: ['status', 'active'] });
    expect(q.filters).toContainEqual({ op: 'eq', args: ['category', '效果渲染'] });
    expect(q.filters).toContainEqual({ op: 'ilike', args: ['title', '%景观%'] });
  });

  it('countTemplates：count 缺失时回退 0', async () => {
    const { client } = makeClient(null);
    configureTemplateGallery({ client: client as never });
    await expect(countTemplates()).resolves.toBe(0);
  });

  it('查询错误时抛出带 error.message 的业务错误', async () => {
    const { client } = makeClient([], { message: 'rls denied' });
    configureTemplateGallery({ client: client as never });
    await expect(listTemplates()).rejects.toThrow(/模板查询失败: rls denied/);
  });
});

describe('模板封面 URL 归一化(2026-10 宿主机迁移,存量 cover_public_url 指向已失联旧网关)', () => {
  const CURRENT_BASE = 'http://10.0.0.220:8021';
  const LEGACY_COVER =
    'http://10.37.80.25:8021/storage/v1/object/public/images/templates/jzxz/abc-cover.jpg';
  const CURRENT_COVER =
    'http://10.0.0.220:8021/storage/v1/object/public/images/templates/jzxz/abc-cover.jpg';

  beforeEach(() => {
    configureTemplateGallery(null);
  });

  it('旧网关绝对直链改写为当前网关,路径原样保留', () => {
    expect(normalizeTemplateCoverUrl(LEGACY_COVER, CURRENT_BASE)).toBe(
      CURRENT_COVER
    );
  });

  it('已是当前网关的 URL 原样返回(幂等)', () => {
    expect(normalizeTemplateCoverUrl(CURRENT_COVER, CURRENT_BASE)).toBe(
      CURRENT_COVER
    );
  });

  it('非 supabase storage 形态的外部图床 URL 不改写', () => {
    const external = 'https://image-assets.soutushenqi.com/acg/x.jpg';
    expect(normalizeTemplateCoverUrl(external, CURRENT_BASE)).toBe(external);
  });

  it('末尾带查询串的 storage URL 改写 origin 后保留查询串', () => {
    expect(
      normalizeTemplateCoverUrl(
        'http://10.37.80.25:8021/storage/v1/object/public/images/a.png?width=300',
        CURRENT_BASE
      )
    ).toBe(`${CURRENT_BASE}/storage/v1/object/public/images/a.png?width=300`);
  });

  it('null / 空串 / 未配置 supabaseUrl 时安全返回原值', () => {
    expect(normalizeTemplateCoverUrl(null, CURRENT_BASE)).toBeNull();
    expect(normalizeTemplateCoverUrl('', CURRENT_BASE)).toBe('');
    expect(normalizeTemplateCoverUrl(LEGACY_COVER, undefined)).toBe(
      LEGACY_COVER
    );
  });

  it('listTemplates:映射行时对 cover_public_url 应用归一化', async () => {
    const { client } = makeClient([
      {
        id: 't1',
        title: '封面指向旧网关的模板',
        cover_public_url: LEGACY_COVER,
      },
      {
        id: 't2',
        title: '无封面模板',
        cover_public_url: null,
      },
    ]);
    configureTemplateGallery({
      client: client as never,
      supabaseUrl: CURRENT_BASE,
    });
    const rows = await listTemplates();
    expect(rows[0].cover_public_url).toBe(CURRENT_COVER);
    expect(rows[1].cover_public_url).toBeNull();
  });
});

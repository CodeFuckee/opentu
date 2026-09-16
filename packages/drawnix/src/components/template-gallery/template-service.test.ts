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
  listTemplates,
  listTemplateCategories,
  recordTemplateUsage,
} from './template-service';

interface RecordedQuery {
  table: string;
  select?: string;
  filters: Array<{ op: string; args: unknown[] }>;
  orders: Array<{ column: string; ascending: boolean }>;
  range?: [number, number];
}

/** 可 await 的链式 builder：记录调用形态，then 时返回固定结果 */
function makeBuilder(table: string, data: unknown, error: unknown = null) {
  const query: RecordedQuery = { table, filters: [], orders: [] };
  const chain: Record<string, unknown> = {
    select: (s: string) => {
      query.select = s;
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
    // supabase-js 的 builder 恒以 { data, error } resolve，不 reject
    then: (resolve: (v: { data: unknown; error: unknown }) => void) =>
      resolve({ data, error }),
  };
  return { chain, query };
}

function makeClient(data: unknown, error: unknown = null) {
  const queries: RecordedQuery[] = [];
  const client = {
    from: (table: string) => {
      const b = makeBuilder(table, data, error);
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

  it('listTemplates：status=active + 主排序键 desc + id tiebreaker + 首页窗口', async () => {
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

  it('查询错误时抛出带 error.message 的业务错误', async () => {
    const { client } = makeClient([], { message: 'rls denied' });
    configureTemplateGallery({ client: client as never });
    await expect(listTemplates()).rejects.toThrow(/模板查询失败: rls denied/);
  });
});

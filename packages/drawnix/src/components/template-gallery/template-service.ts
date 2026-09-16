/**
 * 模板中心数据访问：ai_templates 读取 + use_template 使用计数 RPC
 *
 * 读取依赖 RLS（authenticated 仅可见 status='active'）；
 * 封面经 images 公开桶直链展示（cover_public_url）。
 */
import { getTemplateGalleryConfig } from './runtime';

export interface AiTemplate {
  id: string;
  source: string;
  source_id: string;
  category: string | null;
  catalogs: string[][] | null;
  title: string;
  prompt: string | null;
  base_images: string[] | null;
  template_version: string | null;
  cover_public_url: string | null;
  source_url: string | null;
  likes: number;
  views: number;
  source_use_count: number;
  usage_count: number;
}

export type TemplateSort = 'hot' | 'latest';

export interface TemplateQuery {
  category?: string | null;
  search?: string;
  sort?: TemplateSort;
  limit?: number;
  offset?: number;
}

function requireClient() {
  const config = getTemplateGalleryConfig();
  if (!config) {
    throw new Error('模板中心未初始化（未登录或宿主未接入）');
  }
  return config.client;
}

/** 分页查询 active 模板 */
export async function listTemplates(
  query: TemplateQuery = {}
): Promise<AiTemplate[]> {
  const client = requireClient();
  const {
    category = null,
    search = '',
    sort = 'hot',
    limit = 30,
    offset = 0,
  } = query;

  let builder = client
    .from('ai_templates')
    .select(
      'id, source, source_id, category, catalogs, title, prompt, base_images, template_version, cover_public_url, source_url, likes, views, source_use_count, usage_count'
    )
    .eq('status', 'active')
    .order(sort === 'hot' ? 'usage_count' : 'crawled_at', {
      ascending: false,
    });

  if (sort === 'hot') {
    // 平台使用数大多为 0，并列时按新增时间降序，避免"热度"固定同一批
    builder = builder.order('crawled_at', { ascending: false });
  }
  // 主排序键并列时行序不定，追加 id 做稳定 tiebreaker（翻页不重复/漏行）
  builder = builder
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (category) {
    builder = builder.eq('category', category);
  }
  if (search.trim()) {
    builder = builder.ilike('title', `%${search.trim()}%`);
  }

  const { data, error } = await builder;
  if (error) {
    throw new Error(`模板查询失败: ${error.message}`);
  }
  return (data ?? []) as AiTemplate[];
}

/** 窗口内去重的分类列表（供分类 tab 渲染） */
export async function listTemplateCategories(): Promise<string[]> {
  const client = requireClient();
  const { data, error } = await client
    .from('ai_templates')
    .select('category')
    .eq('status', 'active')
    .not('category', 'is', null);
  if (error) {
    throw new Error(`模板分类查询失败: ${error.message}`);
  }
  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ category: string | null }>) {
    if (row.category) seen.add(row.category);
  }
  return [...seen];
}

/** 当前筛选下的模板总数（head 请求只取 count，不拉数据行） */
export async function countTemplates(
  query: Pick<TemplateQuery, 'category' | 'search'> = {}
): Promise<number> {
  const client = requireClient();
  const { category = null, search = '' } = query;
  let builder = client
    .from('ai_templates')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');
  if (category) {
    builder = builder.eq('category', category);
  }
  if (search.trim()) {
    builder = builder.ilike('title', `%${search.trim()}%`);
  }
  const { count, error } = await builder;
  if (error) {
    throw new Error(`模板数量查询失败: ${error.message}`);
  }
  return count ?? 0;
}

/** 记录使用并原子自增使用计数（RPC security definer） */
export async function recordTemplateUsage(templateId: string): Promise<number> {
  const client = requireClient();
  const { data, error } = await client.rpc('use_template', {
    p_template_id: templateId,
  });
  if (error) {
    throw new Error(`使用计数失败: ${error.message}`);
  }
  return Number(data ?? 0);
}

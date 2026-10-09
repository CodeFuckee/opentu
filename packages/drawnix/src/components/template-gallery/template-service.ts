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
  /** 按 source_id 精确查询(以图搜图相似结果点击进详情用);命中多行取首行 */
  sourceId?: string;
}

function requireClient() {
  const config = getTemplateGalleryConfig();
  if (!config) {
    throw new Error('模板中心未初始化（未登录或宿主未接入）');
  }
  return config.client;
}

/** supabase storage 公开直链的路径标记:命中即视为本自建 supabase 的直链 */
const STORAGE_PUBLIC_MARKER = '/storage/v1/object/public/';

/**
 * 封面直链归一化:把 supabase storage 形态绝对 URL 的 origin 重写到当前网关。
 * 背景:ai_templates.cover_public_url 由爬虫以宿主机当时的网关地址拼绝对 URL
 * 入库(2026-10-09 宿主机迁移 10.37.80.25→10.0.0.220 后存量行全部失联);
 * 展示层重写让存量行与未来网关变更都自愈。外部图床(不含该路径标记)原样返回。
 */
export function normalizeTemplateCoverUrl(
  url: string | null | undefined,
  currentBaseUrl: string | undefined
): string | null | undefined {
  if (!url || !currentBaseUrl) return url;
  const markerIndex = url.indexOf(STORAGE_PUBLIC_MARKER);
  if (markerIndex === -1) return url;
  return `${currentBaseUrl.replace(/\/$/, '')}${url.slice(markerIndex)}`;
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
  if (query.sourceId) {
    builder = builder.eq('source_id', query.sourceId);
  }
  if (search.trim()) {
    builder = builder.ilike('title', `%${search.trim()}%`);
  }

  const { data, error } = await builder;
  if (error) {
    throw new Error(`模板查询失败: ${error.message}`);
  }
  // 存量行的封面是爬虫以历史网关拼的绝对直链,宿主机迁移后失联——
  // 展示层统一重写到当前网关(仅命中 supabase storage 公开直链形态)
  const { supabaseUrl } = getTemplateGalleryConfig() ?? {};
  return (data ?? []).map((row) => ({
    ...(row as AiTemplate),
    cover_public_url: normalizeTemplateCoverUrl(
      (row as AiTemplate).cover_public_url,
      supabaseUrl
    ),
  })) as AiTemplate[];
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

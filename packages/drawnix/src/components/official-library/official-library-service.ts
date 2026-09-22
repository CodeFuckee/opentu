/**
 * 官方素材库数据访问：jzxz_materials 读取（建筑学长贴图爬虫归档）
 *
 * - 表 RLS：authenticated 可读（应用本身有登录门禁），写入只走爬虫（service_role）
 * - 图片公开读桶 jzxz-materials：前端直接用 /object/public/ 直链展示与插入
 * - facets（库/分类/tag 组合）：本机 PostgREST 不支持 distinct，用小列分页扫描 +
 *   客户端去重，模块级缓存；素材网格按筛选服务端分页（count=exact）
 */
import { getOfficialLibraryConfig } from './runtime';
import type { Asset } from '../../types/asset.types';
import { AssetSource, AssetType } from '../../types/asset.types';

export interface OfficialMaterialRow {
  id: string;
  source_id: string;
  gallery: string | null;
  category: string | null;
  tag: string | null;
  name: string | null;
  width: number | null;
  height: number | null;
  preview_path: string | null;
  file_path: string | null;
  content_hash: string | null;
  created_at: string;
}

export interface OfficialFacets {
  /** 有数据的库，按展示顺序（家居库/植物库/配景库优先，未知库名追加在后） */
  galleries: string[];
  /** gallery → 该库实际存在的分类（按展示顺序） */
  categoriesByGallery: Map<string, string[]>;
  /** "分类名" → 该分类实际存在的 tag（按中文字典序）；无分类库为空表 */
  tagsByCategory: Map<string, string[]>;
  /** 库 → 素材数（用于 tab 计数徽标） */
  countsByGallery: Map<string, number>;
  total: number;
}

export interface OfficialMaterialQuery {
  gallery?: string;
  category?: string;
  tag?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface OfficialMaterialPage {
  items: OfficialMaterialRow[];
  total: number;
}

const FACETS_CACHE_TTL_MS = 5 * 60 * 1000;
const FACETS_SCAN_PAGE_SIZE = 1000;

let facetsCache: { facets: OfficialFacets; at: number } | null = null;

/** @internal 仅测试用：清空 facets 模块缓存 */
export function __clearOfficialFacetsCacheForTests(): void {
  facetsCache = null;
}

/** 库/分类展示顺序（与爬虫 GALLERIES/CATE_SLUGS 对齐，未知名追加在尾部） */
const GALLERY_ORDER = ['家居库', '植物库', '配景库'];
const CATEGORY_ORDER = [
  '植物配景', '人物配景', '交通配景', '室内家具', '室内物品',
  '建筑构件', '城市建筑', '景观小品', '动物配景', '自然环境', '总平素材',
];

function byPreferredOrder(preferred: string[]) {
  const rank = new Map(preferred.map((name, index) => [name, index]));
  const fallback = preferred.length;
  return (a: string, b: string) => {
    const ra = rank.get(a) ?? fallback;
    const rb = rank.get(b) ?? fallback;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b, 'zh-Hans-CN');
  };
}

function requireClient() {
  const config = getOfficialLibraryConfig();
  if (!config) {
    throw new Error('官方素材库未初始化（未登录或宿主未接入）');
  }
  return config.client;
}

/** 公开桶直链（匿名可读，HTTP 内网部署下为 LAN 地址） */
export function officialPublicUrl(client: { supabaseUrl: string }, path: string): string {
  return `${client.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/jzxz-materials/${path}`;
}

/**
 * 库/分类/tag 组合：分页扫描小列后客户端去重。
 * 只返回实际有数据的节点（空分类不渲染，爬虫补齐后自动出现）。
 */
export async function listOfficialFacets(forceRefresh = false): Promise<OfficialFacets> {
  if (!forceRefresh && facetsCache && Date.now() - facetsCache.at < FACETS_CACHE_TTL_MS) {
    return facetsCache.facets;
  }

  const client = requireClient();
  const gallerySet = new Set<string>();
  const categoriesByGallery = new Map<string, Set<string>>();
  const tagsByCategory = new Map<string, Set<string>>();
  let total = 0;

  // head 请求只取总数（RLS 内已过滤，与扫描同口径）
  {
    const { count, error } = await client
      .from('jzxz_materials')
      .select('id', { count: 'exact', head: true });
    if (error) {
      throw new Error(`官方素材统计失败: ${error.message}`);
    }
    total = count ?? 0;
  }

  for (let offset = 0; ; offset += FACETS_SCAN_PAGE_SIZE) {
    const { data, error } = await client
      .from('jzxz_materials')
      .select('gallery,category,tag')
      .order('id', { ascending: true })
      .range(offset, offset + FACETS_SCAN_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`官方素材分类查询失败: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{
      gallery: string | null;
      category: string | null;
      tag: string | null;
    }>;
    for (const row of rows) {
      const gallery = row.gallery?.trim();
      if (!gallery) continue;
      gallerySet.add(gallery);
      const category = row.category?.trim();
      if (!category) continue;
      let categorySet = categoriesByGallery.get(gallery);
      if (!categorySet) {
        categorySet = new Set<string>();
        categoriesByGallery.set(gallery, categorySet);
      }
      categorySet.add(category);
      const tag = row.tag?.trim();
      if (!tag) continue;
      let tagSet = tagsByCategory.get(category);
      if (!tagSet) {
        tagSet = new Set<string>();
        tagsByCategory.set(category, tagSet);
      }
      tagSet.add(tag);
    }
    if (rows.length < FACETS_SCAN_PAGE_SIZE) break;
  }

  const galleries = [...gallerySet].sort(byPreferredOrder(GALLERY_ORDER));
  const sortedCategoriesByGallery = new Map<string, string[]>();
  for (const [gallery, categories] of categoriesByGallery) {
    sortedCategoriesByGallery.set(
      gallery,
      [...categories].sort(byPreferredOrder(CATEGORY_ORDER))
    );
  }
  const sortedTagsByCategory = new Map<string, string[]>();
  for (const [category, tags] of tagsByCategory) {
    sortedTagsByCategory.set(category, [...tags].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
  }

  // 库 tab 计数：各库一次 head count（库数量个请求，量级恒定为个位数）
  const countsByGallery = new Map<string, number>();
  for (const gallery of galleries) {
    const { count, error } = await client
      .from('jzxz_materials')
      .select('id', { count: 'exact', head: true })
      .eq('gallery', gallery);
    if (!error) {
      countsByGallery.set(gallery, count ?? 0);
    }
  }

  const facets: OfficialFacets = {
    galleries,
    categoriesByGallery: sortedCategoriesByGallery,
    tagsByCategory: sortedTagsByCategory,
    countsByGallery,
    total,
  };
  facetsCache = { facets, at: Date.now() };
  return facets;
}

/** 按筛选分页查询官方素材（排序 created_at desc + id 稳定 tiebreaker） */
export async function listOfficialMaterials(
  query: OfficialMaterialQuery = {}
): Promise<OfficialMaterialPage> {
  const client = requireClient();
  const {
    gallery,
    category,
    tag,
    search = '',
    limit = 60,
    offset = 0,
  } = query;

  let builder = client
    .from('jzxz_materials')
    .select(
      'id, source_id, gallery, category, tag, name, width, height, preview_path, file_path, content_hash, created_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (gallery) {
    builder = builder.eq('gallery', gallery);
  }
  if (category) {
    builder = builder.eq('category', category);
  }
  if (tag) {
    builder = builder.eq('tag', tag);
  }
  const keyword = search.trim();
  if (keyword) {
    // or 条件引用同值两次需转义引号；ilike 命中素材名或 tag
    builder = builder.or(`name.ilike.%${keyword}%,tag.ilike.%${keyword}%`);
  }

  const { data, error, count } = await builder;
  if (error) {
    throw new Error(`官方素材查询失败: ${error.message}`);
  }
  return {
    items: (data ?? []) as OfficialMaterialRow[],
    total: count ?? 0,
  };
}

/** 官方素材行 → 视图用 Asset（不进 AssetContext/IndexedDB，仅渲染与插入消费） */
export function officialMaterialToAsset(
  row: OfficialMaterialRow,
  supabaseUrl: string
): Asset {
  const path = row.preview_path || row.file_path || '';
  return {
    id: `official-${row.source_id}`,
    type: AssetType.IMAGE,
    source: AssetSource.OFFICIAL,
    url: officialPublicUrl({ supabaseUrl }, path),
    name: row.name || row.tag || row.category || '官方素材',
    mimeType: path.endsWith('.webp')
      ? 'image/webp'
      : path.endsWith('.jpg')
      ? 'image/jpeg'
      : 'image/png',
    createdAt: row.created_at ? Date.parse(row.created_at) : 0,
    prompt: undefined,
  };
}

// ── 家居库产品模型（jzxz_home_materials，jzxz-home-crawler 归档）──
// 与贴图素材（jzxz_materials）的差异：一个素材有多张视图图与可选 glb 模型，
// 无 gallery/width/height；公开桶为 jzxz-home-materials。

export interface HomeMaterialRow {
  source_id: string;
  name: string | null;
  category: string | null;
  tags: string[] | null;
  size_text: string | null;
  image_paths: string[] | null;
  glb_path: string | null;
  glb_name: string | null;
  created_at: string;
}

export interface HomeFacets {
  /** 实际有数据的品类（中文字典序） */
  categories: string[];
  total: number;
}

export interface HomeMaterialQuery {
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface HomeMaterialPage {
  items: HomeMaterialRow[];
  total: number;
}

let homeFacetsCache: { facets: HomeFacets; at: number } | null = null;

/** @internal 仅测试用：清空家居库 facets 模块缓存 */
export function __clearHomeFacetsCacheForTests(): void {
  homeFacetsCache = null;
}

/** 家居库公开桶直链（匿名可读） */
export function homePublicUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/jzxz-home-materials/${path}`;
}

/** 家居库行 → 视图用 Asset（url 取第一张视图图） */
export function homeMaterialToAsset(
  row: HomeMaterialRow,
  supabaseUrl: string
): Asset {
  const path = row.image_paths?.[0] ?? '';
  return {
    id: `official-home-${row.source_id}`,
    type: AssetType.IMAGE,
    source: AssetSource.OFFICIAL,
    url: path ? homePublicUrl(supabaseUrl, path) : '',
    name: row.name || row.category || '家居模型',
    mimeType: path.endsWith('.webp')
      ? 'image/webp'
      : path.endsWith('.jpg')
      ? 'image/jpeg'
      : 'image/png',
    createdAt: row.created_at ? Date.parse(row.created_at) : 0,
    prompt: undefined,
  };
}

/** 行 → 全部视图图直链（预览翻页用） */
export function homeImageUrls(row: HomeMaterialRow, supabaseUrl: string): string[] {
  return (row.image_paths ?? [])
    .filter(Boolean)
    .map((path) => homePublicUrl(supabaseUrl, path));
}

/** 行 → glb 模型直链（无模型返回 null） */
export function homeGlbUrl(row: HomeMaterialRow, supabaseUrl: string): string | null {
  return row.glb_path ? homePublicUrl(supabaseUrl, row.glb_path) : null;
}

/** 家居库 facets：品类去重 + 总数（表为千行级，单页扫描即可） */
export async function listHomeFacets(forceRefresh = false): Promise<HomeFacets> {
  if (
    !forceRefresh &&
    homeFacetsCache &&
    Date.now() - homeFacetsCache.at < FACETS_CACHE_TTL_MS
  ) {
    return homeFacetsCache.facets;
  }
  const client = requireClient();
  const { count, error } = await client
    .from('jzxz_home_materials')
    .select('id', { count: 'exact', head: true });
  if (error) {
    throw new Error(`家居库统计失败: ${error.message}`);
  }
  const categories = new Set<string>();
  for (let offset = 0; ; offset += FACETS_SCAN_PAGE_SIZE) {
    const { data, error: scanError } = await client
      .from('jzxz_home_materials')
      .select('category')
      .order('source_id', { ascending: true })
      .range(offset, offset + FACETS_SCAN_PAGE_SIZE - 1);
    if (scanError) {
      throw new Error(`家居库分类查询失败: ${scanError.message}`);
    }
    const rows = (data ?? []) as Array<{ category: string | null }>;
    for (const row of rows) {
      const category = row.category?.trim();
      if (category) categories.add(category);
    }
    if (rows.length < FACETS_SCAN_PAGE_SIZE) break;
  }
  const facets: HomeFacets = {
    categories: [...categories].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    total: count ?? 0,
  };
  homeFacetsCache = { facets, at: Date.now() };
  return facets;
}

/** 按品类/搜索分页查询家居库（排序 created_at desc + source_id 稳定 tiebreaker） */
export async function listHomeMaterials(
  query: HomeMaterialQuery = {}
): Promise<HomeMaterialPage> {
  const client = requireClient();
  const { category, search = '', limit = 60, offset = 0 } = query;

  let builder = client
    .from('jzxz_home_materials')
    .select(
      'source_id, name, category, tags, size_text, image_paths, glb_path, glb_name, created_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .order('source_id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (category) {
    builder = builder.eq('category', category);
  }
  // 搜索词里的 PostgREST or 语法保留字符会导致过滤器断裂，替换为空格
  const keyword = search.trim().replace(/[,()]/g, ' ').trim();
  if (keyword) {
    // 名称/品类模糊命中；标签为数组列用 cs 包含
    builder = builder.or(
      `name.ilike.%${keyword}%,category.ilike.%${keyword}%,tags.cs.{${keyword}}`
    );
  }

  const { data, error, count } = await builder;
  if (error) {
    throw new Error(`家居库查询失败: ${error.message}`);
  }
  return { items: (data ?? []) as HomeMaterialRow[], total: count ?? 0 };
}

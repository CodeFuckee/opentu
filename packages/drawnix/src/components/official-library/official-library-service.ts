/**
 * 官方素材库数据访问：jzxz_materials（贴图三库）+ 产品模型库
 * （jzxz_home_materials / jzxz_plant_materials，爬虫归档）
 *
 * - 表 RLS：authenticated 可读（应用本身有登录门禁），写入只走爬虫（service_role）
 * - 图片公开读桶 jzxz-materials / jzxz-home-materials / jzxz-plant-materials：
 *   前端直接用 /object/public/ 直链展示与插入
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

/** 行 → 视图用 Asset（id 用行 id：同一文件可挂多分类，source_id 会撞） */
export function officialMaterialToAsset(
  row: OfficialMaterialRow,
  supabaseUrl: string
): Asset {
  const path = row.preview_path || row.file_path || '';
  return {
    id: `official-${row.id}`,
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

// ── 产品模型库（jzxz_home_materials / jzxz_plant_materials，爬虫归档）──
// 两表同构：一个素材一组视图图与可选 glb 模型，无 gallery/width/height；
// 差异仅表名、公开桶与 id 前缀，共用同一套 facets/查询/Asset 映射。

export interface ProductModelRow {
  source_id: string;
  name: string | null;
  category: string | null;
  tags: string[] | null;
  size_text: string | null;
  image_paths: string[] | null;
  glb_path: string | null;
  glb_name: string | null;
  /** glb 体积字节（3D 预览大文件确认用） */
  glb_bytes: number | null;
  created_at: string;
}

export interface ProductModelLibraryConfig {
  /** 库 tab 展示名（同时是 OfficialLibraryView 的 gallery 键） */
  gallery: string;
  table: string;
  bucket: string;
  /** Asset id 前缀（`${idPrefix}-${source_id}`） */
  idPrefix: string;
  /** 名称缺失时的回退名 */
  fallbackName: string;
}

export const PRODUCT_MODEL_LIBRARIES = {
  家居库: {
    gallery: '家居库',
    table: 'jzxz_home_materials',
    bucket: 'jzxz-home-materials',
    idPrefix: 'official-home',
    fallbackName: '家居模型',
  },
  植物库: {
    gallery: '植物库',
    table: 'jzxz_plant_materials',
    bucket: 'jzxz-plant-materials',
    idPrefix: 'official-plant',
    fallbackName: '植物素材',
  },
} as const satisfies Record<string, ProductModelLibraryConfig>;

export type ProductModelFacets = {
  /** 实际有数据的品类（中文字典序） */
  categories: string[];
  total: number;
};

export type ProductModelQuery = {
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

export type ProductModelPage = {
  items: ProductModelRow[];
  total: number;
};

const productFacetsCaches = new Map<
  string,
  { facets: ProductModelFacets; at: number }
>();

/** @internal 仅测试用：清空产品模型库 facets 模块缓存 */
export function __clearProductModelFacetsCacheForTests(): void {
  productFacetsCaches.clear();
}

/** 产品模型库公开桶直链（匿名可读） */
export function productModelPublicUrl(
  config: Pick<ProductModelLibraryConfig, 'bucket'>,
  supabaseUrl: string,
  path: string
): string {
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${config.bucket}/${path}`;
}

/** 行 → 视图用 Asset（url 取第一张视图图；携带整组视图与产品元信息） */
export function productModelToAsset(
  config: ProductModelLibraryConfig,
  row: ProductModelRow,
  supabaseUrl: string
): Asset {
  const path = row.image_paths?.[0] ?? '';
  return {
    id: `${config.idPrefix}-${row.source_id}`,
    type: AssetType.IMAGE,
    source: AssetSource.OFFICIAL,
    url: path ? productModelPublicUrl(config, supabaseUrl, path) : '',
    name: row.name || row.category || config.fallbackName,
    mimeType: path.endsWith('.webp')
      ? 'image/webp'
      : path.endsWith('.jpg')
      ? 'image/jpeg'
      : 'image/png',
    createdAt: row.created_at ? Date.parse(row.created_at) : 0,
    prompt: undefined,
    viewImageUrls: productModelImageUrls(config, row, supabaseUrl),
    homeMeta: {
      category: row.category,
      tags: row.tags ?? [],
      sizeText: row.size_text,
      glbUrl: row.glb_path
        ? productModelPublicUrl(config, supabaseUrl, row.glb_path)
        : null,
      glbName: row.glb_name,
      glbBytes: row.glb_bytes ?? null,
    },
  };
}

/** 行 → 全部视图图直链（预览翻页用） */
export function productModelImageUrls(
  config: Pick<ProductModelLibraryConfig, 'bucket'>,
  row: ProductModelRow,
  supabaseUrl: string
): string[] {
  return (row.image_paths ?? [])
    .filter(Boolean)
    .map((path) => productModelPublicUrl(config, supabaseUrl, path));
}

/** 行 → glb 模型直链（无模型返回 null） */
export function productModelGlbUrl(
  config: Pick<ProductModelLibraryConfig, 'bucket'>,
  row: ProductModelRow,
  supabaseUrl: string
): string | null {
  return row.glb_path
    ? productModelPublicUrl(config, supabaseUrl, row.glb_path)
    : null;
}

/** 产品模型库 facets：品类去重 + 总数（表为千行级，单页扫描即可） */
export async function listProductModelFacets(
  config: ProductModelLibraryConfig,
  forceRefresh = false
): Promise<ProductModelFacets> {
  const cached = productFacetsCaches.get(config.table);
  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.at < FACETS_CACHE_TTL_MS
  ) {
    return cached.facets;
  }
  const client = requireClient();
  const { count, error } = await client
    .from(config.table)
    .select('id', { count: 'exact', head: true });
  if (error) {
    throw new Error(`${config.gallery}统计失败: ${error.message}`);
  }
  const categories = new Set<string>();
  for (let offset = 0; ; offset += FACETS_SCAN_PAGE_SIZE) {
    const { data, error: scanError } = await client
      .from(config.table)
      .select('category')
      .order('source_id', { ascending: true })
      .range(offset, offset + FACETS_SCAN_PAGE_SIZE - 1);
    if (scanError) {
      throw new Error(`${config.gallery}分类查询失败: ${scanError.message}`);
    }
    const rows = (data ?? []) as Array<{ category: string | null }>;
    for (const row of rows) {
      const category = row.category?.trim();
      if (category) categories.add(category);
    }
    if (rows.length < FACETS_SCAN_PAGE_SIZE) break;
  }
  const facets: ProductModelFacets = {
    categories: [...categories].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    total: count ?? 0,
  };
  productFacetsCaches.set(config.table, { facets, at: Date.now() });
  return facets;
}

/** 按品类/搜索分页查询产品模型库（排序 created_at desc + source_id 稳定 tiebreaker） */
export async function listProductModelMaterials(
  config: ProductModelLibraryConfig,
  query: ProductModelQuery = {}
): Promise<ProductModelPage> {
  const client = requireClient();
  const { category, search = '', limit = 60, offset = 0 } = query;

  let builder = client
    .from(config.table)
    .select(
      'source_id, name, category, tags, size_text, image_paths, glb_path, glb_name, glb_bytes, created_at',
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
    throw new Error(`${config.gallery}查询失败: ${error.message}`);
  }
  return { items: (data ?? []) as ProductModelRow[], total: count ?? 0 };
}

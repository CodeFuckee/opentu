/**
 * 官方素材库数据访问层单测：用链式 mock Supabase 客户端锁定查询形态
 * （分页扫描、range 窗口、count=exact、排序 tiebreaker、or-ilike 搜索、
 * facets 去重与缓存、公开直链拼接、Asset 映射、未注册抛错）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  configureOfficialLibrary,
  getOfficialLibraryConfig,
} from './runtime';
import {
  __clearOfficialFacetsCacheForTests,
  __clearProductModelFacetsCacheForTests,
  PRODUCT_MODEL_LIBRARIES,
  listOfficialFacets,
  listOfficialMaterials,
  listProductModelFacets,
  listProductModelMaterials,
  officialMaterialToAsset,
  officialPublicUrl,
  productModelGlbUrl,
  productModelImageUrls,
  productModelPublicUrl,
  productModelToAsset,
} from './official-library-service';
import { AssetSource, AssetType } from '../../types/asset.types';

interface RecordedQuery {
  table: string;
  select?: string;
  selectOpts?: { count?: string; head?: boolean };
  filters: Array<{ op: string; args: unknown[] }>;
  orders: Array<{ column: string; ascending: boolean }>;
  range?: [number, number];
}

/** 可 await 的链式 builder：记录调用形态，then 时按脚本依次弹出结果 */
function makeBuilder(table: string, results: Array<{ data: unknown; error: unknown; count: number | null }>) {
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
    or: (...args: unknown[]) => {
      query.filters.push({ op: 'or', args });
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
    then: (resolve: (v: { data: unknown; error: unknown; count: number | null }) => void) =>
      resolve(results.shift() ?? { data: [], error: null, count: null }),
  };
  return { chain, query };
}

/** 多结果客户端：每次 from() 消费一个结果脚本 */
function makeMultiClient(scripts: Array<Array<{ data: unknown; error: unknown; count: number | null }>>) {
  const queries: RecordedQuery[] = [];
  const client = {
    supabaseUrl: 'http://10.37.80.25:8021',
    from: (_table: string) => {
      const b = makeBuilder(_table, scripts.shift() ?? []);
      queries.push(b.query);
      return b.chain;
    },
  };
  return { client, queries };
}

describe('official-library runtime 注册表', () => {
  it('未注册时 getOfficialLibraryConfig 返回 null', () => {
    configureOfficialLibrary(null);
    expect(getOfficialLibraryConfig()).toBeNull();
  });

  it('注册后可取回配置，注销后为 null', () => {
    const config = { client: {} as never, supabaseUrl: 'http://10.37.80.25:8021' };
    configureOfficialLibrary(config);
    expect(getOfficialLibraryConfig()).toBe(config);
    configureOfficialLibrary(null);
    expect(getOfficialLibraryConfig()).toBeNull();
  });
});

describe('listOfficialFacets', () => {
  beforeEach(() => {
    configureOfficialLibrary(null);
    __clearOfficialFacetsCacheForTests();
  });

  it('扫描去重：空分类/空 tag 不产出节点，库与分类按定制顺序', async () => {
    const rows = [
      { gallery: '配景库', category: '植物配景', tag: '绿树' },
      { gallery: '配景库', category: '植物配景', tag: '绿树' }, // 重复组合
      { gallery: '配景库', category: '自然环境', tag: null }, // 有分类无 tag
      { gallery: '家居库', category: null, tag: null }, // 无分类库
      { gallery: null, category: null, tag: null }, // 脏行：无库跳过
      { gallery: '新库', category: '未知分类', tag: '某tag' }, // 未知名
    ];
    const { client, queries } = makeMultiClient([
      [{ data: null, error: null, count: rows.length }], // total head
      [{ data: rows, error: null, count: null }], // 扫描一页即尽
      [{ data: null, error: null, count: 1 }], // 家居库计数（排序后第一个）
      [{ data: null, error: null, count: 4 }], // 配景库计数
      [{ data: null, error: null, count: 1 }], // 新库计数
    ]);
    configureOfficialLibrary({ client: client as never, supabaseUrl: 'http://10.37.80.25:8021' });

    const facets = await listOfficialFacets();

    expect(facets.galleries).toEqual(['家居库', '配景库', '新库']);
    expect(facets.categoriesByGallery.get('配景库')).toEqual(['植物配景', '自然环境']);
    expect(facets.categoriesByGallery.has('家居库')).toBe(false);
    expect(facets.tagsByCategory.get('植物配景')).toEqual(['绿树']);
    expect(facets.tagsByCategory.has('自然环境')).toBe(false);
    expect(facets.countsByGallery.get('配景库')).toBe(4);
    expect(facets.total).toBe(rows.length);

    // 扫描请求形态：小列 + range 分页
    const scan = queries[1];
    expect(scan.select).toBe('gallery,category,tag');
    expect(scan.range).toEqual([0, 999]);
    // 库计数：head + eq gallery（排序后第一个是家居库）
    const galleryCount = queries[2];
    expect(galleryCount.selectOpts).toMatchObject({ count: 'exact', head: true });
    expect(galleryCount.filters).toContainEqual({ op: 'eq', args: ['gallery', '家居库'] });
  });

  it('total head 失败时抛错', async () => {
    const { client } = makeMultiClient([
      [{ data: null, error: { message: 'boom' }, count: null }],
    ]);
    configureOfficialLibrary({ client: client as never, supabaseUrl: 'http://10.37.80.25:8021' });
    await expect(listOfficialFacets()).rejects.toThrow('官方素材统计失败');
  });

  it('缓存命中时不发请求（5 分钟 TTL）', async () => {
    const rows = [{ gallery: '家居库', category: null, tag: null }];
    const first = makeMultiClient([
      [{ data: null, error: null, count: 1 }],
      [{ data: rows, error: null, count: null }],
      [{ data: null, error: null, count: 1 }],
    ]);
    configureOfficialLibrary({ client: first.client as never });
    await listOfficialFacets();

    // 未 resetModules、未 forceRefresh：直接命中缓存
    const again = await listOfficialFacets();
    expect(again.galleries).toEqual(['家居库']);
    expect(again.total).toBe(1);

    // forceRefresh 绕过缓存：客户端脚本已耗尽，from 会拿到空脚本但缓存已走
    const cached = await listOfficialFacets(false);
    expect(cached.galleries).toEqual(['家居库']);
  });
});

describe('listOfficialMaterials', () => {
  beforeEach(() => {
    configureOfficialLibrary(null);
    __clearOfficialFacetsCacheForTests();
  });

  it('查询形态：created_at desc + id tiebreaker + range + count exact', async () => {
    const { client, queries } = makeMultiClient([
      [{ data: [], error: null, count: 0 }],
    ]);
    configureOfficialLibrary({ client: client as never, supabaseUrl: 'http://10.37.80.25:8021' });

    await listOfficialMaterials({ limit: 60, offset: 120 });

    const q = queries[0];
    expect(q.select).toContain('source_id');
    expect(q.selectOpts).toMatchObject({ count: 'exact' });
    expect(q.orders).toEqual([
      { column: 'created_at', ascending: false },
      { column: 'id', ascending: true },
    ]);
    expect(q.range).toEqual([120, 179]);
    expect(q.filters).toHaveLength(0);
  });

  it('筛选条件逐项下推（gallery/category/tag + or-ilike 搜索）', async () => {
    const { client, queries } = makeMultiClient([
      [{ data: [], error: null, count: 0 }],
    ]);
    configureOfficialLibrary({ client: client as never, supabaseUrl: 'http://10.37.80.25:8021' });

    await listOfficialMaterials({
      gallery: '配景库',
      category: '植物配景',
      tag: '绿树',
      search: '松 ',
    });

    const q = queries[0];
    expect(q.filters).toEqual([
      { op: 'eq', args: ['gallery', '配景库'] },
      { op: 'eq', args: ['category', '植物配景'] },
      { op: 'eq', args: ['tag', '绿树'] },
      { op: 'or', args: ['name.ilike.%松%,tag.ilike.%松%'] },
    ]);
  });

  it('查询失败抛错并携带信息', async () => {
    const { client } = makeMultiClient([
      [{ data: null, error: { message: 'boom' }, count: null }],
    ]);
    configureOfficialLibrary({ client: client as never, supabaseUrl: 'http://10.37.80.25:8021' });
    await expect(listOfficialMaterials()).rejects.toThrow('官方素材查询失败');
  });
});

describe('URL 拼接与 Asset 映射', () => {
  beforeEach(() => {
    configureOfficialLibrary(null);
    __clearOfficialFacetsCacheForTests();
  });

  it('officialPublicUrl 拼公开桶直链并容忍尾斜杠', () => {
    expect(officialPublicUrl({ supabaseUrl: 'http://10.37.80.25:8021' }, 'a/b.png')).toBe(
      'http://10.37.80.25:8021/storage/v1/object/public/jzxz-materials/a/b.png'
    );
    expect(officialPublicUrl({ supabaseUrl: 'http://host:8021/' }, 'a.png')).toBe(
      'http://host:8021/storage/v1/object/public/jzxz-materials/a.png'
    );
  });

  it('officialMaterialToAsset：official- 前缀 id、IMAGE/OFFICIAL、直链、名称回退链', () => {
    const asset = officialMaterialToAsset(
      {
        id: 'uuid-1',
        source_id: 'src-1',
        gallery: '配景库',
        category: '植物配景',
        tag: '绿树',
        name: 'F-Affair',
        width: 800,
        height: 600,
        preview_path: 'plant-scene/abc.jpg',
        file_path: 'plant-scene/abc.jpg',
        content_hash: 'h',
        created_at: '2026-09-20T00:00:00Z',
      },
      'http://10.37.80.25:8021'
    );
    expect(asset.id).toBe('official-src-1');
    expect(asset.type).toBe(AssetType.IMAGE);
    expect(asset.source).toBe(AssetSource.OFFICIAL);
    expect(asset.url).toBe(
      'http://10.37.80.25:8021/storage/v1/object/public/jzxz-materials/plant-scene/abc.jpg'
    );
    expect(asset.name).toBe('F-Affair');
    expect(asset.mimeType).toBe('image/jpeg');
    expect(asset.createdAt).toBe(Date.parse('2026-09-20T00:00:00Z'));
  });

  it('officialMaterialToAsset：无名称时回退 tag → category → 默认', () => {
    const asset = officialMaterialToAsset(
      {
        id: 'uuid-2',
        source_id: 'src-2',
        gallery: '家居库',
        category: null,
        tag: null,
        name: null,
        width: null,
        height: null,
        preview_path: null,
        file_path: null,
        content_hash: null,
        created_at: null,
      },
      'http://h:8021'
    );
    expect(asset.name).toBe('官方素材');
    expect(asset.url).toContain('/storage/v1/object/public/jzxz-materials/');
    expect(asset.mimeType).toBe('image/png');
    expect(asset.createdAt).toBe(0);
  });
});

describe('产品模型库（jzxz_home_materials / jzxz_plant_materials）', () => {
  const row = {
    source_id: 'sid-1',
    name: '现代吊灯',
    category: '灯具',
    tags: ['现代', '北欧'],
    size_text: '1200x300',
    image_paths: ['home/sid-1/img-0.png', 'home/sid-1/img-1.jpg'],
    glb_path: 'home/sid-1/model.glb',
    glb_name: 'model.glb',
    created_at: '2026-09-22T00:00:00Z',
  };

  beforeEach(() => {
    configureOfficialLibrary(null);
    __clearProductModelFacetsCacheForTests();
  });

  it('productModelPublicUrl：按库配置拼各自公开桶直链并容忍尾斜杠', () => {
    expect(
      productModelPublicUrl(
        PRODUCT_MODEL_LIBRARIES.家居库,
        'http://h:8021/',
        'home/a.png'
      )
    ).toBe('http://h:8021/storage/v1/object/public/jzxz-home-materials/home/a.png');
    expect(
      productModelPublicUrl(
        PRODUCT_MODEL_LIBRARIES.植物库,
        'http://h:8021',
        'plant/a.png'
      )
    ).toBe('http://h:8021/storage/v1/object/public/jzxz-plant-materials/plant/a.png');
  });

  it('productModelToAsset：id 前缀按库区分，url 取第一张视图图，名称回退链', () => {
    const home = productModelToAsset(
      PRODUCT_MODEL_LIBRARIES.家居库,
      row,
      'http://h:8021'
    );
    expect(home.id).toBe('official-home-sid-1');
    expect(home.url).toBe(
      'http://h:8021/storage/v1/object/public/jzxz-home-materials/home/sid-1/img-0.png'
    );
    expect(home.name).toBe('现代吊灯');
    expect(home.viewImageUrls).toHaveLength(2);
    expect(home.homeMeta?.glbUrl).toContain('model.glb');

    const plant = productModelToAsset(
      PRODUCT_MODEL_LIBRARIES.植物库,
      { ...row, name: null, glb_path: null, glb_name: null },
      'http://h:8021'
    );
    expect(plant.id).toBe('official-plant-sid-1');
    expect(plant.name).toBe('灯具');
    expect(plant.homeMeta?.glbUrl).toBeNull();
  });

  it('productModelImageUrls/productModelGlbUrl：多视图与模型直链，无模型返回 null', () => {
    const urls = productModelImageUrls(
      PRODUCT_MODEL_LIBRARIES.家居库,
      row,
      'http://h:8021'
    );
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('img-1.jpg');
    expect(
      productModelGlbUrl(PRODUCT_MODEL_LIBRARIES.家居库, row, 'http://h:8021')
    ).toContain('model.glb');
    expect(
      productModelGlbUrl(
        PRODUCT_MODEL_LIBRARIES.家居库,
        { ...row, glb_path: null },
        'http://h:8021'
      )
    ).toBeNull();
  });

  it('listProductModelMaterials：表名按库区分，查询形态与 or 搜索（含 tags.cs）', async () => {
    const { client, queries } = makeMultiClient([
      [{ data: [row], error: null, count: 1 }],
    ]);
    configureOfficialLibrary({ client: client as never, supabaseUrl: 'http://10.37.80.25:8021' });

    const page = await listProductModelMaterials(PRODUCT_MODEL_LIBRARIES.植物库, {
      category: '常绿大乔',
      search: '玉兰',
      limit: 60,
      offset: 60,
    });

    expect(page.total).toBe(1);
    expect(page.items[0].source_id).toBe('sid-1');
    const q = queries[0];
    expect(q.table).toBe('jzxz_plant_materials');
    expect(q.select).toContain('image_paths');
    expect(q.selectOpts).toMatchObject({ count: 'exact' });
    expect(q.orders).toEqual([
      { column: 'created_at', ascending: false },
      { column: 'source_id', ascending: true },
    ]);
    expect(q.range).toEqual([60, 119]);
    expect(q.filters).toContainEqual({ op: 'eq', args: ['category', '常绿大乔'] });
    const or = q.filters.find((f) => f.op === 'or');
    expect(String((or as { args: unknown[] }).args[0])).toContain('tags.cs.{玉兰}');
  });

  it('listProductModelFacets：head 总数 + 品类扫描去重 + 缓存按表隔离', async () => {
    const rows = [
      { category: '常绿大乔' },
      { category: '常绿大乔' },
      { category: '球形' },
      { category: null },
    ];
    const { client } = makeMultiClient([
      [{ data: null, error: null, count: 4 }],
      [{ data: rows, error: null, count: null }],
    ]);
    configureOfficialLibrary({ client: client as never, supabaseUrl: 'http://10.37.80.25:8021' });

    const facets = await listProductModelFacets(PRODUCT_MODEL_LIBRARIES.植物库);
    expect(facets.total).toBe(4);
    expect(facets.categories).toEqual(['常绿大乔', '球形']);

    // 植物库缓存命中：home 查询不受影响（各自缓存），植物库换抛错客户端也不发请求
    const broken = {
      supabaseUrl: 'http://h',
      from: () => {
        throw new Error('should not query');
      },
    };
    configureOfficialLibrary({ client: broken as never, supabaseUrl: 'http://h' });
    const cached = await listProductModelFacets(PRODUCT_MODEL_LIBRARIES.植物库);
    expect(cached.total).toBe(4);
    await expect(
      listProductModelFacets(PRODUCT_MODEL_LIBRARIES.家居库)
    ).rejects.toThrow('should not query');
  });

  it('listProductModelFacets/listProductModelMaterials 失败抛错并携带库名', async () => {
    const { client } = makeMultiClient([
      [{ data: null, error: { message: 'boom' }, count: null }],
    ]);
    configureOfficialLibrary({ client: client as never, supabaseUrl: 'http://10.37.80.25:8021' });
    await expect(
      listProductModelFacets(PRODUCT_MODEL_LIBRARIES.植物库)
    ).rejects.toThrow('植物库统计失败');

    const { client: client2 } = makeMultiClient([
      [{ data: null, error: { message: 'boom' }, count: null }],
    ]);
    configureOfficialLibrary({ client: client2 as never, supabaseUrl: 'http://10.37.80.25:8021' });
    await expect(
      listProductModelMaterials(PRODUCT_MODEL_LIBRARIES.植物库)
    ).rejects.toThrow('植物库查询失败');
  });
});

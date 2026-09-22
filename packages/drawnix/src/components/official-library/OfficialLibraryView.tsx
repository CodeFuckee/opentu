/**
 * Official Library View
 * 官方素材库视图 - 建筑学长贴图素材（jzxz_materials）三级分类浏览
 *
 * 建筑学长面板层级：库 tab（家居库/植物库/配景库）→ 分类 chips（仅配景库有）
 * → tag chips → 素材网格。数据服务端分页（count=exact），滚动近底自动加载下一页。
 * 素材只读：公开桶直链展示与插入，不写入个人素材库。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input, Loading } from 'tdesign-react';
import { Search, RefreshCw, Library } from 'lucide-react';
import { VirtualAssetGrid } from '../media-library/VirtualAssetGrid';
import { MediaLibraryEmpty } from '../media-library/MediaLibraryEmpty';
import {
  UnifiedMediaViewer,
  type MediaItem as UnifiedMediaItem,
} from '../shared/media-preview';
import { insertImageFromUrl } from '../../data/image';
import { useDrawnix } from '../../hooks/use-drawnix';
import { HoverTip } from '../shared/hover';
import { getOfficialLibraryConfig } from './runtime';
import {
  homeGlbUrl,
  homeImageUrls,
  homeMaterialToAsset,
  listHomeFacets,
  listHomeMaterials,
  listOfficialFacets,
  listOfficialMaterials,
  officialMaterialToAsset,
  type HomeFacets,
  type HomeMaterialPage,
  type HomeMaterialRow,
  type OfficialFacets,
  type OfficialMaterialPage,
} from './official-library-service';
import type { Asset } from '../../types/asset.types';
import '../media-library/MediaLibraryGrid.scss';
import './official-library.scss';

const PAGE_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 300;

export interface OfficialLibraryViewProps {
  /** 当前选中（官方素材 id，official- 前缀） */
  selectedAssetId: string | null;
  /** 单击选中（回传完整 Asset，供 Inspector 展示） */
  onSelectAsset: (asset: Asset) => void;
  /** 使用素材（SELECT 模式回传宿主；BROWSE 模式宿主未传时由预览器直插画布） */
  onUseAsset?: (asset: Asset) => void;
}

export function OfficialLibraryView({
  selectedAssetId,
  onSelectAsset,
  onUseAsset,
}: OfficialLibraryViewProps) {
  const { board } = useDrawnix();
  const configured = !!getOfficialLibraryConfig();

  // facets（库/分类/tag 组合）
  const [facets, setFacets] = useState<OfficialFacets | null>(null);
  const [facetsError, setFacetsError] = useState<string | null>(null);
  const [facetsLoading, setFacetsLoading] = useState(false);

  // 家居库（jzxz_home_materials 产品模型，独立于贴图 facets）
  const [homeFacets, setHomeFacets] = useState<HomeFacets | null>(null);
  const homeExtrasRef = useRef(
    new Map<
      string,
      { imageUrls: string[]; glbUrl: string | null; row: HomeMaterialRow }
    >()
  );

  // 三级筛选 + 搜索
  const [activeGallery, setActiveGallery] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // 素材分页
  const [assets, setAssets] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestSeqRef = useRef(0);

  // 预览
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewItems, setPreviewItems] = useState<UnifiedMediaItem[]>([]);
  const [previewInitialIndex, setPreviewInitialIndex] = useState(0);

  const supabaseUrl = getOfficialLibraryConfig()?.supabaseUrl ?? '';

  // 加载 facets
  const loadFacets = useCallback(async () => {
    if (!configured) return;
    setFacetsLoading(true);
    setFacetsError(null);
    try {
      const [result, home] = await Promise.all([
        listOfficialFacets(),
        listHomeFacets().catch((error) => {
          // 家居库（新表）失败不拖垮贴图三库，仅隐藏其 tab
          console.error('[OfficialLibrary] 家居库加载失败:', error);
          return null;
        }),
      ]);
      setFacets(result);
      setHomeFacets(home);
      setActiveGallery(
        (prev) => prev ?? (home && home.total > 0 ? '家居库' : result.galleries[0] ?? null)
      );
    } catch (error) {
      setFacetsError(error instanceof Error ? error.message : '官方素材库加载失败');
    } finally {
      setFacetsLoading(false);
    }
  }, [configured]);

  useEffect(() => {
    void loadFacets();
  }, [loadFacets]);

  // 搜索防抖
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // 家居库 tab 读产品模型表，其余库读贴图表
  const isHomeGallery = activeGallery === '家居库' && !!homeFacets;

  const fetchPage = useCallback(
    (offset: number) =>
      isHomeGallery
        ? listHomeMaterials({
            category: activeCategory ?? undefined,
            search,
            limit: PAGE_SIZE,
            offset,
          })
        : listOfficialMaterials({
            gallery: activeGallery ?? undefined,
            category: activeCategory ?? undefined,
            tag: activeTag ?? undefined,
            search,
            limit: PAGE_SIZE,
            offset,
          }),
    [isHomeGallery, activeGallery, activeCategory, activeTag, search]
  );

  const applyPage = useCallback(
    (page: HomeMaterialPage | OfficialMaterialPage, append: boolean) => {
      if (isHomeGallery) {
        const homeRows = (page as HomeMaterialPage).items;
        const next = homeRows.map((row) => {
          const asset = homeMaterialToAsset(row, supabaseUrl);
          homeExtrasRef.current.set(asset.id, {
            imageUrls: homeImageUrls(row, supabaseUrl),
            glbUrl: homeGlbUrl(row, supabaseUrl),
            row,
          });
          return asset;
        });
        setAssets((prev) => (append ? [...prev, ...next] : next));
      } else {
        const next = (page as OfficialMaterialPage).items.map((row) =>
          officialMaterialToAsset(row, supabaseUrl)
        );
        setAssets((prev) => (append ? [...prev, ...next] : next));
      }
      setTotal(page.total);
    },
    [isHomeGallery, supabaseUrl]
  );

  // 筛选/搜索变化 → 重置到第一页
  useEffect(() => {
    if (!facets || !activeGallery) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    fetchPage(0)
      .then((page) => {
        if (requestSeqRef.current !== seq) return;
        applyPage(page, false);
      })
      .catch((error) => {
        if (requestSeqRef.current !== seq) return;
        setAssets([]);
        setTotal(0);
        console.error('[OfficialLibrary] 加载素材失败:', error);
      })
      .finally(() => {
        if (requestSeqRef.current === seq) setLoading(false);
      });
  }, [facets, activeGallery, fetchPage, applyPage]);

  const hasMore = assets.length < total;

  // 加载下一页（追加）
  const loadMore = useCallback(() => {
    if (!facets || !activeGallery || !hasMore || loading || loadingMore) return;
    const seq = requestSeqRef.current;
    setLoadingMore(true);
    fetchPage(assets.length)
      .then((page) => {
        if (requestSeqRef.current !== seq) return;
        applyPage(page, true);
      })
      .catch((error) => {
        console.error('[OfficialLibrary] 加载更多失败:', error);
      })
      .finally(() => {
        if (requestSeqRef.current === seq) setLoadingMore(false);
      });
  }, [
    facets,
    activeGallery,
    fetchPage,
    applyPage,
    assets.length,
    hasMore,
    loading,
    loadingMore,
  ]);

  // 切换库：清空分类/tag
  const handleGalleryChange = useCallback((gallery: string) => {
    setActiveGallery(gallery);
    setActiveCategory(null);
    setActiveTag(null);
  }, []);

  // 切换分类：清空 tag（再次点击取消选中）
  const handleCategoryChange = useCallback((category: string) => {
    setActiveCategory((prev) => (prev === category ? null : category));
    setActiveTag(null);
  }, []);

  const handleTagChange = useCallback((tag: string) => {
    setActiveTag((prev) => (prev === tag ? null : tag));
  }, []);

  // 预览：贴图库以当前网格全部素材为上下文；家居库预览单个素材的全部视图图
  const handlePreview = useCallback(
    (asset: Asset) => {
      const extra = homeExtrasRef.current.get(asset.id);
      if (extra) {
        const items: UnifiedMediaItem[] = extra.imageUrls.map((url, index) => ({
          id: `${asset.id}#view-${index}`,
          type: 'image',
          url,
          title: asset.name
            ? `${asset.name}（${index + 1}/${extra.imageUrls.length}）`
            : undefined,
          alt: asset.name,
        }));
        setPreviewItems(items);
        setPreviewInitialIndex(0);
        setPreviewVisible(true);
        return;
      }
      const items: UnifiedMediaItem[] = assets.map((a) => ({
        id: a.id,
        type: 'image',
        url: a.url,
        title: a.name,
        alt: a.name,
      }));
      const index = assets.findIndex((a) => a.id === asset.id);
      setPreviewItems(items);
      setPreviewInitialIndex(index >= 0 ? index : 0);
      setPreviewVisible(true);
    },
    [assets]
  );

  const handlePreviewClose = useCallback(() => {
    setPreviewVisible(false);
  }, []);

  // 预览器插入：优先走宿主使用回调，否则直插画布（公开直链）
  // 家居库素材预览项为“单素材多视图”（id 带 #view-N 后缀），插入当前翻到的视图
  const handleInsertFromViewer = useCallback(
    async (item: UnifiedMediaItem) => {
      const viewMatch = item.id.match(/^(.+)#view-\d+$/);
      if (viewMatch) {
        const asset = assets.find((a) => a.id === viewMatch[1]);
        if (onUseAsset && asset) {
          onUseAsset({ ...asset, url: item.url });
          return;
        }
        if (board) {
          try {
            await insertImageFromUrl(board, item.url);
            setPreviewVisible(false);
          } catch (error) {
            console.error('[OfficialLibrary] 插入画布失败:', error);
          }
        }
        return;
      }
      if (onUseAsset) {
        const asset = assets.find((a) => a.id === item.id);
        if (asset) {
          onUseAsset(asset);
          return;
        }
      }
      if (board) {
        try {
          await insertImageFromUrl(board, item.url);
          setPreviewVisible(false);
        } catch (error) {
          console.error('[OfficialLibrary] 插入画布失败:', error);
        }
      }
    },
    [assets, onUseAsset, board]
  );

  const galleryCategories = useMemo(
    () =>
      isHomeGallery
        ? homeFacets?.categories ?? []
        : activeGallery
        ? facets?.categoriesByGallery.get(activeGallery) ?? []
        : [],
    [isHomeGallery, homeFacets, facets, activeGallery]
  );
  const activeTags = useMemo(
    () =>
      isHomeGallery || !activeCategory
        ? []
        : facets?.tagsByCategory.get(activeCategory) ?? [],
    [isHomeGallery, facets, activeCategory]
  );

  // 库 tab 列表：家居库（产品模型）+ 贴图三库（去重）
  const mergedGalleries = useMemo(() => {
    const list: string[] = [];
    if (homeFacets && homeFacets.total > 0) list.push('家居库');
    for (const gallery of facets?.galleries ?? []) {
      if (gallery !== '家居库') list.push(gallery);
    }
    return list;
  }, [facets, homeFacets]);

  const galleryCountFor = useCallback(
    (gallery: string) =>
      gallery === '家居库'
        ? homeFacets?.total
        : facets?.countsByGallery.get(gallery),
    [facets, homeFacets]
  );

  // 选中条目的家居库元信息（品类/标签/尺寸 + glb 下载）
  const selectedHomeExtra = useMemo(() => {
    if (!selectedAssetId) return null;
    return homeExtrasRef.current.get(selectedAssetId) ?? null;
    // assets 依赖：确保网格加载后再查映射
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAssetId, assets]);

  // ── 未注册（未登录/宿主未接入）：空态降级 ──
  if (!configured) {
    return (
      <div className="media-library-grid official-library" data-testid="official-library-view">
        <div className="official-library__unavailable">
          <Library size={40} />
          <h3>官方素材库暂不可用</h3>
          <p>登录后即可浏览官方素材库</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="media-library-grid official-library"
      data-testid="official-library-view"
    >
      <div className="media-library-grid__header">
        <div className="media-library-grid__header-top">
          <div className="media-library-grid__search">
            <Input
              value={searchInput}
              onChange={(value) => setSearchInput(value as string)}
              placeholder="搜索官方素材名称或标签..."
              prefixIcon={<Search size={16} />}
              clearable
              data-track="official_library_search_input"
            />
          </div>
          {facetsLoading && (
            <div className="official-library__facets-loading">
              <Loading size="small" text="加载分类中..." />
            </div>
          )}
        </div>
        <div className="media-library-grid__header-bottom">
          <div className="media-library-grid__filter-island">
            {/* 库 tab（家居库=产品模型，其余=贴图库） */}
            <div className="media-library-grid__type-tabs">
              {mergedGalleries.map((gallery) => {
                const count = galleryCountFor(gallery);
                const isActive = activeGallery === gallery;
                return (
                  <HoverTip
                    key={gallery}
                    content={count !== undefined ? `${gallery} (${count})` : gallery}
                    placement="top"
                    showArrow={false}
                  >
                    <button
                      type="button"
                      aria-label={`${gallery}${count !== undefined ? `：${count}` : ''}`}
                      aria-pressed={isActive}
                      className={`media-library-grid__type-tab ${
                        isActive ? 'media-library-grid__type-tab--active' : ''
                      }`}
                      onClick={() => handleGalleryChange(gallery)}
                      data-track="official_library_gallery_tab"
                    >
                      <Library size={14} strokeWidth={1.5} />
                      <span className="media-library-grid__type-tab-label">
                        {gallery}
                      </span>
                      {count !== undefined && (
                        <span className="media-library-grid__type-tab-count">
                          {count}
                        </span>
                      )}
                    </button>
                  </HoverTip>
                );
              })}
            </div>

            {/* 品类/分类 chips（家居库品类上百个，单行横向滚动） */}
            {galleryCategories.length > 0 && (
              <div
                className={`media-library-grid__filter-tags${
                  isHomeGallery ? ' media-library-grid__filter-tags--scrollable' : ''
                }`}
              >
                <span className="media-library-grid__filter-tags-label">
                  {isHomeGallery ? '品类' : '分类'}
                </span>
                {galleryCategories.map((category) => {
                  const isActive = activeCategory === category;
                  return (
                    <button
                      key={category}
                      type="button"
                      aria-pressed={isActive}
                      className={`media-library-grid__filter-chip ${
                        isActive ? 'media-library-grid__filter-chip--active' : ''
                      }`}
                      onClick={() => handleCategoryChange(category)}
                      data-track="official_library_category_chip"
                    >
                      <span className="media-library-grid__filter-chip-label">
                        {category}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* tag chips（选中分类后显示） */}
            {activeCategory && activeTags.length > 0 && (
              <div className="media-library-grid__filter-tags">
                <span className="media-library-grid__filter-tags-label">标签</span>
                {activeTags.map((tag) => {
                  const isActive = activeTag === tag;
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={isActive}
                      className={`media-library-grid__filter-chip ${
                        isActive ? 'media-library-grid__filter-chip--active' : ''
                      }`}
                      onClick={() => handleTagChange(tag)}
                      data-track="official_library_tag_chip"
                    >
                      <span className="media-library-grid__filter-chip-label">
                        {tag}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* facets 加载失败：错误 + 重试 */}
      {facetsError ? (
        <div className="official-library__status">
          <p className="official-library__status-text">加载失败：{facetsError}</p>
          <button
            type="button"
            className="official-library__retry-btn"
            onClick={() => void loadFacets()}
          >
            <RefreshCw size={14} />
            重试
          </button>
        </div>
      ) : loading ? (
        <div className="official-library__status">
          <Loading size="large" text="加载素材中..." />
        </div>
      ) : assets.length === 0 ? (
        <div className="official-library__status">
          {search || activeTag || activeCategory ? (
            <p className="official-library__status-text">未找到匹配的官方素材</p>
          ) : (
            <MediaLibraryEmpty />
          )}
        </div>
      ) : (
        <>
          <div className="media-library-grid__container">
            <VirtualAssetGrid
              assets={assets}
              viewMode="grid"
              selectedAssetId={selectedAssetId ?? undefined}
              isAssetSelected={() => false}
              isSelectionMode={false}
              onSelectAsset={(assetId) => {
                const asset = assets.find((a) => a.id === assetId);
                if (asset) onSelectAsset(asset);
              }}
              onPreview={handlePreview}
              onLoadMore={loadMore}
              onDoubleClick={onUseAsset}
            />
          </div>

          {/* 家居库选中条目元信息条（品类/标签/尺寸 + glb 下载） */}
          {selectedHomeExtra && (
            <div
              className="official-library__home-meta"
              data-testid="official-library-home-meta"
            >
              <span className="official-library__home-meta-item">
                品类：{selectedHomeExtra.row.category || '—'}
              </span>
              <span className="official-library__home-meta-item">
                标签：
                {selectedHomeExtra.row.tags?.length
                  ? selectedHomeExtra.row.tags.join(' / ')
                  : '—'}
              </span>
              <span className="official-library__home-meta-item">
                尺寸：{selectedHomeExtra.row.size_text || '—'}
              </span>
              {selectedHomeExtra.glbUrl && (
                <a
                  className="official-library__home-meta-glb"
                  href={selectedHomeExtra.glbUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-track="official_library_home_glb_download"
                >
                  下载 3D 模型（glb）
                </a>
              )}
            </div>
          )}

          {/* 底部工具栏 */}
          <div className="media-library-grid__footer">
            <div className="media-library-grid__footer-left">
              <span className="media-library-grid__footer-count">
                共 {total} 个素材
              </span>
              {loadingMore ? (
                <span className="media-library-grid__footer-hint">
                  <Loading size="small" text="加载中..." />
                </span>
              ) : hasMore ? (
                <span className="media-library-grid__footer-hint">
                  滚动加载更多
                </span>
              ) : (
                <span className="media-library-grid__footer-hint">
                  已加载全部
                </span>
              )}
              {!onUseAsset && (
                <span className="media-library-grid__footer-hint">双击预览</span>
              )}
            </div>
          </div>
        </>
      )}

      {/* 媒体预览器 */}
      <UnifiedMediaViewer
        visible={previewVisible}
        items={previewItems}
        initialIndex={previewInitialIndex}
        onClose={handlePreviewClose}
        showThumbnails={true}
        onInsertToCanvas={board ? handleInsertFromViewer : undefined}
      />
    </div>
  );
}

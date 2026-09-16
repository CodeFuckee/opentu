/**
 * 模板中心 UI：分类 tab + 热度/最新 + 搜索 + 瀑布流卡片 + 详情弹层
 *
 * 对标建筑学长 AI 模板广场（OpenSpec add-template-gallery）。
 * 宿主未注册 supabase 客户端（未登录）时不渲染。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import classNames from 'classnames';
import {
  getTemplateGalleryConfig,
} from './runtime';
import {
  countTemplates,
  listTemplateCategories,
  listTemplates,
  recordTemplateUsage,
  type AiTemplate,
  type TemplateSort,
} from './template-service';
import './template-gallery.scss';

export interface TemplateGalleryProps {
  open: boolean;
  onClose: () => void;
  /** 用户点击「去创作」：把模板提示词交给 AI 输入框 */
  onUseTemplate: (template: AiTemplate) => void;
  language?: 'zh' | 'en';
}

const PAGE_SIZE = 30;

export const TemplateGallery: React.FC<TemplateGalleryProps> = ({
  open,
  onClose,
  onUseTemplate,
  language = 'zh',
}) => {
  const enabled = Boolean(getTemplateGalleryConfig());
  const [categories, setCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<TemplateSort>('hot');
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [templates, setTemplates] = useState<AiTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiTemplate | null>(null);
  const [usingId, setUsingId] = useState<string | null>(null);

  // 加载分类
  useEffect(() => {
    if (!open || !enabled) return;
    listTemplateCategories()
      .then((cats) => setCategories(cats))
      .catch(() => setCategories([]));
  }, [open, enabled]);

  // 加载模板列表：请求序号防竞态（过期响应一律丢弃）；滚动到底自动追加下一页
  const loadSeqRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(
    async (offset: number) => {
      if (!open || !enabled) return;
      const seq = ++loadSeqRef.current;
      if (offset === 0) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      try {
        const rows = await listTemplates({
          category: activeCategory,
          search,
          sort,
          limit: PAGE_SIZE,
          offset,
        });
        if (seq !== loadSeqRef.current) return;
        setHasMore(rows.length === PAGE_SIZE);
        if (offset === 0) {
          setTemplates(rows);
        } else {
          setTemplates((prev) => {
            const seen = new Set(prev.map((t) => t.id));
            return [...prev, ...rows.filter((r) => !seen.has(r.id))];
          });
        }
      } catch (e) {
        if (seq !== loadSeqRef.current) return;
        setError(e instanceof Error ? e.message : '模板加载失败');
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [open, enabled, activeCategory, search, sort]
  );

  // 分类/搜索/排序变化或重新打开：重置回第一页
  useEffect(() => {
    if (!open || !enabled) return;
    void fetchPage(0);
  }, [fetchPage, open, enabled]);

  // 滚动接近底部时自动追加下一页
  const maybeLoadMore = useCallback(() => {
    const el = bodyRef.current;
    if (!el || loading || loadingMore || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      void fetchPage(templates.length);
    }
  }, [fetchPage, loading, loadingMore, hasMore, templates.length]);

  // 首页不足一屏时自动补页，保证后续滚动加载可触发
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || loading || loadingMore || !hasMore) return;
    if (el.scrollHeight <= el.clientHeight + 40) {
      void fetchPage(templates.length);
    }
  }, [templates, loading, loadingMore, hasMore, fetchPage]);

  // 右上角总数展示（随分类/搜索刷新；失败静默，不影响主流程）
  const countSeqRef = useRef(0);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const refreshCount = useCallback(async () => {
    if (!open || !enabled) return;
    const seq = ++countSeqRef.current;
    try {
      const n = await countTemplates({ category: activeCategory, search });
      if (seq === countSeqRef.current) setTotalCount(n);
    } catch {
      if (seq === countSeqRef.current) setTotalCount(null);
    }
  }, [open, enabled, activeCategory, search]);

  useEffect(() => {
    void refreshCount();
  }, [refreshCount]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleUse = useCallback(
    async (template: AiTemplate) => {
      setUsingId(template.id);
      try {
        await recordTemplateUsage(template.id);
      } catch {
        // 计数失败不阻塞使用
      }
      onUseTemplate(template);
      setDetail(null);
      onClose();
    },
    [onUseTemplate, onClose]
  );

  if (!open) return null;

  if (!enabled) {
    return createPortal(
      <div className="template-gallery__overlay" onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}>
        <div className="template-gallery template-gallery--empty">
          <div className="template-gallery__state">
            {language === 'zh' ? '请先登录后使用模板中心' : 'Please sign in to use templates'}
          </div>
          <button className="template-gallery__close" onClick={onClose}>×</button>
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      className="template-gallery__overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="template-gallery-overlay"
    >
      <div className="template-gallery">
        <div className="template-gallery__header">
          <div className="template-gallery__title">
            {language === 'zh' ? 'AI 模板' : 'AI Templates'}
          </div>
          <div className="template-gallery__search">
            <input
              value={searchDraft}
              placeholder={language === 'zh' ? '搜索模板' : 'Search templates'}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setSearch(searchDraft);
              }}
            />
            {search ? (
              <button
                className="template-gallery__search-clear"
                onClick={() => {
                  setSearchDraft('');
                  setSearch('');
                }}
              >
                ×
              </button>
            ) : null}
          </div>
          <div className="template-gallery__sort">
            <button
              className={classNames({ active: sort === 'hot' })}
              onClick={() => setSort('hot')}
            >
              {language === 'zh' ? '热度' : 'Hot'}
            </button>
            <button
              className={classNames({ active: sort === 'latest' })}
              onClick={() => setSort('latest')}
            >
              {language === 'zh' ? '最新' : 'Latest'}
            </button>
          </div>
          {totalCount !== null ? (
            <span
              className="template-gallery__count"
              data-testid="template-gallery-count"
            >
              {language === 'zh' ? `共 ${totalCount} 个` : `${totalCount} templates`}
            </span>
          ) : null}
          <button
            className="template-gallery__close"
            onClick={onClose}
            aria-label={language === 'zh' ? '关闭' : 'Close'}
          >
            ×
          </button>
        </div>

        {categories.length > 0 ? (
          <div className="template-gallery__categories">
            <button
              className={classNames({ active: activeCategory === null })}
              onClick={() => setActiveCategory(null)}
            >
              {language === 'zh' ? '全部' : 'All'}
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                className={classNames({ active: activeCategory === cat })}
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        ) : null}

        <div
          className="template-gallery__body"
          ref={bodyRef}
          onScroll={maybeLoadMore}
        >
          {loading ? (
            <div className="template-gallery__state">
              {language === 'zh' ? '加载中…' : 'Loading…'}
            </div>
          ) : error ? (
            <div className="template-gallery__state template-gallery__state--error">
              {error}
            </div>
          ) : templates.length === 0 ? (
            <div className="template-gallery__state">
              {language === 'zh' ? '暂无模板' : 'No templates'}
            </div>
          ) : (
            <div className="template-gallery__masonry">
              {templates.map((template) => (
                <button
                  key={template.id}
                  className="template-gallery__card"
                  onClick={() => setDetail(template)}
                  data-testid="template-gallery-card"
                >
                  <div className="template-gallery__card-cover">
                    {template.cover_public_url ? (
                      <img
                        src={template.cover_public_url}
                        alt={template.title}
                        loading="lazy"
                      />
                    ) : (
                      <div className="template-gallery__card-cover-placeholder" />
                    )}
                  </div>
                  <div className="template-gallery__card-meta">
                    <div className="template-gallery__card-title">
                      {template.title}
                    </div>
                    <div className="template-gallery__card-stats">
                      <span>{`❤ ${template.likes}`}</span>
                      <span>{`↗ ${template.usage_count}`}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {loadingMore ? (
            <div className="template-gallery__more">加载中…</div>
          ) : null}
          {!loading && !hasMore && templates.length > 0 ? (
            <div className="template-gallery__more">
              已加载全部 {templates.length} 个模板
            </div>
          ) : null}
        </div>

        {detail ? (
          <div
            className="template-gallery__detail-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setDetail(null);
            }}
          >
            <div className="template-gallery__detail">
              <button
                className="template-gallery__detail-close"
                onClick={() => setDetail(null)}
                aria-label={language === 'zh' ? '返回' : 'Back'}
              >
                ×
              </button>
              {detail.cover_public_url ? (
                <img
                  className="template-gallery__detail-cover"
                  src={detail.cover_public_url}
                  alt={detail.title}
                />
              ) : null}
              <div className="template-gallery__detail-body">
                <div className="template-gallery__detail-title">
                  {detail.title}
                </div>
                {detail.base_images && detail.base_images.length > 0 ? (
                  <div className="template-gallery__detail-base">
                    <span className="template-gallery__detail-base-label">
                      {language === 'zh' ? '原图/参考图' : 'Reference'}
                    </span>
                    <div className="template-gallery__detail-base-images">
                      {detail.base_images.map((src) => (
                        <img key={src} src={src} alt="" loading="lazy" />
                      ))}
                    </div>
                  </div>
                ) : null}
                {detail.catalogs?.length ? (
                  <div className="template-gallery__detail-catalogs">
                    {detail.catalogs.flat().map((cat) => (
                      <span key={cat}>{cat}</span>
                    ))}
                  </div>
                ) : null}
                <pre className="template-gallery__detail-prompt">
                  {detail.prompt ?? (language === 'zh' ? '（无提示词）' : '(no prompt)')}
                </pre>
                <div className="template-gallery__detail-actions">
                  <button
                    className="template-gallery__detail-copy"
                    onClick={() => {
                      if (detail.prompt) {
                        void navigator.clipboard?.writeText(detail.prompt);
                      }
                    }}
                  >
                    {language === 'zh' ? '复制提示词' : 'Copy prompt'}
                  </button>
                  <button
                    className="template-gallery__detail-use"
                    disabled={usingId === detail.id || !detail.prompt}
                    onClick={() => void handleUse(detail)}
                    data-testid="template-gallery-use"
                  >
                    {language === 'zh' ? '去创作' : 'Create'}
                  </button>
                </div>
                {detail.source_url ? (
                  <a
                    className="template-gallery__detail-source"
                    href={detail.source_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {language === 'zh' ? '查看来源' : 'Source'}
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
};

export default TemplateGallery;

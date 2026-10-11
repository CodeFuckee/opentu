/**
 * 按钮使用统计采集器（openspec add-button-usage-stats）
 *
 * 在应用壳层以捕获阶段监听整页按钮点击（含画布内按钮），自动识别按钮标识，
 * 批量上报到 ui-stats 边缘函数入库（ui_click_events 表）。
 *
 * 按钮标识优先级：data-track > data-testid > aria-label > 'text:'+可见文本前 20 字。
 * 上报失败的事件写入 localStorage 缓存，随下次批量一并重试（上限防膨胀）。
 * 应用就绪后额外上报一次「按钮清单」（inv: 前缀），作为看板零使用对比基线。
 *
 * 隐私口径：只记按钮标识与页面路径，不记录任何输入内容。
 */

export interface CapturedButton {
  id: string;
  label: string;
}

export interface UiStatsEvent {
  page: string;
  buttonId: string;
  buttonLabel?: string;
  appVersion?: string;
}

export interface UiStatsCaptureOptions {
  /** ui-stats ingest 完整地址（{SUPABASE_URL}/functions/v1/ui-stats/ingest） */
  endpoint: string;
  /** Kong 放行用的 anon key（dashboard-stats 同款惯例） */
  anonKey: string;
  /** 动态取当前会话 access_token（临期刷新逻辑由宿主提供） */
  getAccessToken: () => Promise<string | null>;
  appVersion?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/** localStorage 缓存 key（沿用 tracking-cache 惯例的明文 JSON 队列） */
export const UI_STATS_CACHE_KEY = 'ui_stats_pending_cache';
/** 缓存条数上限：防长期离线膨胀，超限丢最旧 */
const CACHE_MAX_EVENTS = 500;
/** 清单上报的标识数上限 */
export const INVENTORY_MAX_ITEMS = 300;

const BUTTON_SELECTOR = 'button, [role="button"]';

function trimText(value: string | null | undefined, max: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 从点击目标解析按钮标识：向上找最近的 button/[role=button]，
 * 无任何可用标识时返回 null（如装饰性 div）。
 */
export function resolveButton(target: EventTarget | null): CapturedButton | null {
  if (!(target instanceof Element)) return null;
  const button = target.closest(BUTTON_SELECTOR) as HTMLElement | null;
  if (!button) return null;

  const trackId = button.getAttribute('data-track');
  const testId = button.getAttribute('data-testid');
  const ariaLabel = trimText(button.getAttribute('aria-label'), 60);
  const text = trimText(button.textContent, 20);

  let id: string | null = null;
  if (trackId) id = trackId;
  else if (testId) id = testId;
  else if (ariaLabel) id = ariaLabel;
  else if (text) id = `text:${text}`;

  if (!id) return null;
  return { id, label: ariaLabel || text || id };
}

/** 待发送事件（含失败重试缓存里的旧事件） */
type QueuedEvent = UiStatsEvent;

export class UiStatsCapture {
  private readonly options: Required<
    Pick<UiStatsCaptureOptions, 'endpoint' | 'anonKey' | 'batchSize' | 'flushIntervalMs'>
  > &
    UiStatsCaptureOptions;
  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private started = false;

  constructor(options: UiStatsCaptureOptions) {
    this.options = {
      batchSize: 20,
      flushIntervalMs: 15_000,
      ...options,
    };
  }

  start(): void {
    if (this.started || typeof document === 'undefined') return;
    this.started = true;
    // capture 阶段：确保先于应用内 stopPropagation 的处理拿到点击
    document.addEventListener('click', this.handleClick, { capture: true });
    window.addEventListener('pagehide', this.handlePageHide);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.timer = setInterval(() => {
      // 到点即发：定时器本身就是「不满批也要定期送出」的兜底通道
      void this.flush(true);
    }, this.options.flushIntervalMs);
    this.restoreCache();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    document.removeEventListener('click', this.handleClick, { capture: true });
    window.removeEventListener('pagehide', this.handlePageHide);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 供启动清单上报：buttonId 加 inv: 前缀，按批串行送出（去重、上限 300） */
  async reportInventory(root: ParentNode = document): Promise<void> {
    const ids = new Set<string>();
    const labels = new Map<string, string>();
    root.querySelectorAll(BUTTON_SELECTOR).forEach((el) => {
      const resolved = resolveButton(el);
      if (resolved && ids.size < INVENTORY_MAX_ITEMS) {
        ids.add(resolved.id);
        if (!labels.has(resolved.id)) labels.set(resolved.id, resolved.label);
      }
    });
    const events: QueuedEvent[] = [...ids].map((id) => ({
      page: 'inventory',
      buttonId: `inv:${id}`,
      buttonLabel: labels.get(id),
      appVersion: this.options.appVersion,
    }));
    for (let i = 0; i < events.length; i += this.options.batchSize) {
      this.queue.push(...events.slice(i, i + this.options.batchSize));
      await this.flush(true);
    }
  }

  private handleClick = (event: MouseEvent): void => {
    // 只处理主键点击；识别不到按钮标识的点击丢弃
    if (event.button !== 0) return;
    const resolved = resolveButton(event.target);
    if (!resolved) return;
    this.enqueue({
      page: window.location.pathname,
      buttonId: resolved.id,
      buttonLabel: resolved.label,
    });
  };

  private handlePageHide = (): void => {
    void this.flush(true);
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      void this.flush(true);
    }
  };

  private enqueue(event: UiStatsEvent): void {
    this.queue.push({
      ...event,
      appVersion: event.appVersion ?? this.options.appVersion,
    });
    if (this.queue.length >= this.options.batchSize) {
      void this.flush();
    }
  }

  /**
   * 批量上报：合并失败缓存 + 当前队列，一次 POST（keepalive 保证 pagehide 可达）。
   * 全部成功清缓存；失败则整体写回缓存待下轮重试。
   */
  async flush(force = false): Promise<void> {
    if (this.flushing) return;
    if (!force && this.queue.length < this.options.batchSize) return;
    const cached = this.readCache();
    const events = [...cached, ...this.queue].slice(0, CACHE_MAX_EVENTS);
    if (events.length === 0) return;

    this.flushing = true;
    this.queue = [];
    try {
      const token = await this.options.getAccessToken();
      if (!token) {
        // 未登录：不丢数据，整批回缓存等登录后重试（events 已截断到上限）
        this.writeCache(events);
        return;
      }
      const doFetch = this.options.fetchFn || fetch;
      const response = await doFetch(this.options.endpoint, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          apikey: this.options.anonKey,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ events }),
      });
      if (!response.ok) {
        throw new Error(`ui-stats ingest failed: ${response.status}`);
      }
      this.options.storage?.removeItem(UI_STATS_CACHE_KEY);
    } catch {
      // 上报失败：整批回缓存（截断到上限），下轮 flush 一并重试
      this.writeCache(events);
    } finally {
      this.flushing = false;
    }
  }

  private readCache(): UiStatsEvent[] {
    try {
      const raw = this.options.storage?.getItem(UI_STATS_CACHE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as UiStatsEvent[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeCache(events: UiStatsEvent[]): void {
    try {
      if (events.length === 0) {
        this.options.storage?.removeItem(UI_STATS_CACHE_KEY);
        return;
      }
      this.options.storage?.setItem(UI_STATS_CACHE_KEY, JSON.stringify(events));
    } catch {
      // 存储不可用（隐私模式/超配额）时静默放弃缓存
    }
  }

  private restoreCache(): void {
    // 启动时把缓存事件并入队列，由正常 flush 节奏带出
    const cached = this.readCache();
    if (cached.length > 0) {
      this.options.storage?.removeItem(UI_STATS_CACHE_KEY);
      this.queue.push(...cached);
    }
  }
}

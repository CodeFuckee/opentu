/**
 * 按钮使用统计采集器单测
 *
 * 覆盖：按钮识别各级 fallback、点击入队与批量触发、定时 flush、
 * pagehide/隐藏兜底、失败缓存与恢复、启动清单上报、未登录不丢数据。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INVENTORY_MAX_ITEMS,
  UI_STATS_CACHE_KEY,
  UiStatsCapture,
  resolveButton,
} from './ui-stats-capture';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

function mountButton(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

function clickElement(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function successFetch() {
  return vi.fn(async () => new Response(null, { status: 200 }));
}

describe('resolveButton', () => {
  it('data-track 优先', () => {
    const el = mountButton(
      '<button data-track="toolbar_click_delete" data-testid="t" aria-label="删除">删除</button>'
    );
    expect(resolveButton(el)).toEqual({ id: 'toolbar_click_delete', label: '删除' });
  });

  it('无 data-track 回退 data-testid', () => {
    const el = mountButton('<button data-testid="task-queue-toggle">队列</button>');
    expect(resolveButton(el)?.id).toBe('task-queue-toggle');
  });

  it('回退 aria-label', () => {
    const el = mountButton('<button aria-label="打开工具箱"><span/></button>');
    expect(resolveButton(el)).toEqual({ id: '打开工具箱', label: '打开工具箱' });
  });

  it('回退 text: 前缀 + 文本前 20 字（压缩空白）', () => {
    const el = mountButton('<button>  确定   保存草稿并退出编辑  </button>');
    const resolved = resolveButton(el);
    expect(resolved?.id).toBe('text:确定 保存草稿并退出编辑');
    expect((resolved?.id ?? '').length).toBeLessThanOrEqual(26);
  });

  it('无标识返回 null；role=button 也可识别', () => {
    expect(resolveButton(document.createElement('div'))).toBeNull();
    const empty = mountButton('<button><span></span></button>');
    expect(resolveButton(empty)).toBeNull();
    const role = mountButton('<div role="button" aria-label="菜单">x</div>');
    expect(resolveButton(role)?.id).toBe('菜单');
  });
});

describe('UiStatsCapture', () => {
  let storage = memoryStorage();

  beforeEach(() => {
    storage = memoryStorage();
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createCapture(overrides: Record<string, unknown> = {}) {
    const fetchFn = successFetch();
    const capture = new UiStatsCapture({
      endpoint: 'http://supabase.local/functions/v1/ui-stats/ingest',
      anonKey: 'anon-key',
      getAccessToken: async () => 'token-1',
      appVersion: '1.0.10',
      storage,
      fetchFn: fetchFn as unknown as typeof fetch,
      ...overrides,
    });
    return { capture, fetchFn };
  }

  it('点击入队，满 batchSize 触发上报（body/headers/page 正确）', async () => {
    const { capture, fetchFn } = createCapture({ batchSize: 2 });
    capture.start();
    const b1 = mountButton('<button data-track="btn_a">A</button>');
    const b2 = mountButton('<button aria-label="按钮B">B</button>');
    clickElement(b1);
    clickElement(b2);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/functions/v1/ui-stats/ingest');
    expect((init.headers as Record<string, string>).apikey).toBe('anon-key');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    const body = JSON.parse(String(init.body));
    expect(body.events).toEqual([
      { page: '/', buttonId: 'btn_a', buttonLabel: 'A', appVersion: '1.0.10' },
      { page: '/', buttonId: '按钮B', buttonLabel: '按钮B', appVersion: '1.0.10' },
    ]);
  });

  it('不足批量时按 flushInterval 定时上报', async () => {
    const { capture, fetchFn } = createCapture({ batchSize: 5, flushIntervalMs: 15_000 });
    capture.start();
    clickElement(mountButton('<button data-track="btn_x">X</button>'));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('pagehide 立即兜底上报', async () => {
    const { capture, fetchFn } = createCapture({ batchSize: 5 });
    capture.start();
    clickElement(mountButton('<button data-track="btn_y">Y</button>'));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('上报失败写缓存，下一轮 flush 合并重试', async () => {
    const failing = vi.fn(async () => new Response(null, { status: 502 }));
    const { capture } = createCapture({ batchSize: 1, fetchFn: failing as unknown as typeof fetch });
    capture.start();
    clickElement(mountButton('<button data-track="btn_f1">F1</button>'));
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(storage.getItem(UI_STATS_CACHE_KEY) ?? '[]')).toHaveLength(1);

    // 恢复后：缓存事件并入下一次批量
    const succeeding = successFetch();
    (capture as unknown as { options: { fetchFn: typeof fetch } }).options.fetchFn =
      succeeding as unknown as typeof fetch;
    clickElement(mountButton('<button data-track="btn_f2">F2</button>'));
    await vi.advanceTimersByTimeAsync(0);
    const body = JSON.parse(String(succeeding.mock.calls[0][1]?.body));
    expect(body.events.map((e: { buttonId: string }) => e.buttonId)).toEqual([
      'btn_f1',
      'btn_f2',
    ]);
    expect(storage.getItem(UI_STATS_CACHE_KEY)).toBeNull();
  });

  it('未登录时整批回缓存不丢数据', async () => {
    const { capture, fetchFn } = createCapture({
      batchSize: 1,
      getAccessToken: async () => null,
    });
    capture.start();
    clickElement(mountButton('<button data-track="btn_nologin">NL</button>'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).not.toHaveBeenCalled();
    const cached = JSON.parse(storage.getItem(UI_STATS_CACHE_KEY) ?? '[]');
    expect(cached[0].buttonId).toBe('btn_nologin');
  });

  it('reportInventory 上报 inv: 前缀清单（去重）', async () => {
    const { capture, fetchFn } = createCapture();
    mountButton('<button data-track="inv_a">A</button>');
    mountButton('<button data-track="inv_a">A 重复</button>');
    mountButton('<button aria-label="菜单">M</button>');
    await capture.reportInventory();

    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    const ids = body.events.map((e: { buttonId: string }) => e.buttonId).sort();
    expect(ids).toEqual(['inv:inv_a', 'inv:菜单']);
    expect(body.events[0].page).toBe('inventory');
  });

  it(`inventory 标识数不超过 ${INVENTORY_MAX_ITEMS}（超批量自动分批）`, async () => {
    const { capture, fetchFn } = createCapture();
    for (let i = 0; i < INVENTORY_MAX_ITEMS + 10; i++) {
      mountButton(`<button data-track="many_${i}">M${i}</button>`);
    }
    await capture.reportInventory();
    // flush(force) 逐批送出直到队列排空，合计恰为上限条数
    let total = 0;
    for (const call of fetchFn.mock.calls) {
      total += (JSON.parse(String(call[1]?.body)).events as unknown[]).length;
    }
    expect(total).toBe(INVENTORY_MAX_ITEMS);
  });
});

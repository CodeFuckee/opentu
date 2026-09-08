/**
 * 画布交互测试辅助函数
 *
 * 依赖真实 DOM 结构（recon 验证）：
 * - board-host-svg 尺寸(2560x1440)大于视口且居中 => 用「视口中心 + 偏移」定位；
 * - 工具按钮/radio 的点击方式：TDesign 风格 radio 需点击 label/容器才切换选中态；
 * - 元素插入与删除均为异步，必须用 expect.poll / toHaveCount 轮询等待。
 */
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { E2E_STATE_PATH } from '../config/e2e.config';

/** 点击工具 radio 的直接父级 label（.tool-icon），触发受控 radio 切换 */
export async function clickToolRadio(
  page: Page,
  radio: Locator
): Promise<void> {
  const label = radio.locator('xpath=..');
  await label.click({ force: true });
  await expect(radio).toBeChecked({ timeout: 5000 });
}

/** 视口中心点 + 偏移 -> 页面坐标（世界坐标中心即视口中心） */
export function screenAt(page: Page, dx: number, dy: number) {
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  return { x: vp.width / 2 + dx, y: vp.height / 2 + dy };
}

/** 元素宿主中的图形元素数量（含 plait-data-id 的元素节点） */
export function elementCount(page: Page) {
  return page
    .locator('.board-host-svg .element-host [plait-data-id]')
    .count();
}

/**
 * 轮询等待元素数量 > 0（元素创建是异步渲染）。
 *
 * 超时给到 20s：CI 的 E2E 跑在编译打包模式（vite preview 生产构建产物），
 * 画布/形状/文本等依赖懒加载 chunk（manualChunks + idle-prefetch），首次交互
 * 需等 chunk 下载执行，dev server 下的 8s 会偶发超时（drawing 用例 flaky）。
 */
export async function expectElementsCreated(page: Page) {
  await expect
    .poll(() => elementCount(page), { timeout: 20000, intervals: [200] })
    .toBeGreaterThan(0);
}

/**
 * 让灵感创意板在页面加载前就处于「用户已隐藏」状态（localStorage 偏好
 * aitu_hide_inspiration_board），从根子消除「板子晚到覆盖画布中心，吞掉首次
 * 落笔 / 把按键导入 AI 输入框」的竞态（preview 模式 drawing 用例首试
 * flaky 的根因）。板子全程不挂载，比 dismissInspirationBoard 的运行时隐藏
 * 更确定。仅 drawing.spec 使用（灵感板自身功能用例需要板子可见）。
 */
export async function hideInspirationBoard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('aitu_hide_inspiration_board', 'true');
    } catch {
      // 极端同源限制下 localStorage 不可用则忽略，由 dismissInspirationBoard 兜底
    }
  });
}

/**
 * 预热画布核心运行时（best-effort，失败不抛错）：在 drawing 套件首个用例前
 * 调用一次，用独立浏览器上下文打开画布，真画一个矩形并插入一段文本，把
 * 「生产构建首次交互」（懒加载 chunk 下载执行、首屏竞态）的冷启动成本全部
 * 移到预热阶段，让每个被测用例只跑一次也能稳定通过。
 *
 * 为何用独立上下文：旧版预热在用例内切工具，遗留的工具状态/退化元素会污染
 * 用例断言（画笔用例曾因此失败）；独立页面画完即弃，零状态泄漏。预热页同样
 * 注入板子隐藏偏好，保证预热绘制不被板子吞掉。
 */
export async function warmUpCanvasRuntime(browser: Browser): Promise<void> {
  let ctx: BrowserContext | undefined;
  try {
    ctx = await browser.newContext({ storageState: E2E_STATE_PATH });
    const page = await ctx.newPage();
    await hideInspirationBoard(page);
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 30000,
    });
    // 画布可交互稳定信号：切 Rectangle 并等 pointer-rectangle（图形链 chunk 就绪）
    await focusCanvasEmptyArea(page);
    await pressToolKey(page, 'r', 'rectangle');
    // 首个「慢绘」发生在预热页而非被测用例内
    await drawRectangle(page);
    // 顺带预热文本编辑链（Slate 编辑器 chunk），让文本用例首次输入不丢字
    const textRadio = page.getByRole('radio', { name: /文本/ }).first();
    await clickToolRadio(page, textRadio);
    await waitForPointer(page, 'text');
    const vp = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.click(vp.width / 2 - 200, vp.height / 2);
    await page.waitForTimeout(400);
    await page.keyboard.type('预热文本');
    await page.mouse.click(vp.width / 2 + 250, vp.height / 2 + 150);
    await page.waitForTimeout(300);
  } catch {
    // best-effort：预热失败时被测用例自带的 20s 轮询 + 板子隐藏注入仍可兜底
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}

/**
 * 关闭灵感创意板（空画布时它覆盖画布并拦截绘制事件）。
 * 慢速宿主上板子可能带入场动画，入场完成前不可见：只检查一次可见性会漏掉，
 * 稍后板子出现并吞掉中心区域落笔（HOSTDIAG 实测 pointerdown 命中
 * testid=inspiration-board）。这里轮询等待板子真正消失。
 */
export async function dismissInspirationBoard(page: Page): Promise<void> {
  const hide = page.locator('[data-track="inspiration_click_hide"]').first();
  const board = page.getByTestId('inspiration-board');
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await hide.isVisible().catch(() => false)) {
      await hide.click({ force: true });
    }
    try {
      await expect(board).toBeHidden({ timeout: 2000 });
      return;
    } catch {
      // 板子可能刚入场/重新出现，下轮再关
      await page.waitForTimeout(300);
    }
  }
  await expect(board).toBeHidden({ timeout: 5000 });
}

/**
 * 点击画布空白处，把键盘焦点还给画布宿主（快捷键依赖 board 焦点）。
 * 位置取视口中心偏上，避开心灵板/底部 AI 输入栏/中心元素。
 */
export async function focusCanvasEmptyArea(page: Page): Promise<void> {
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const x = vp.width / 2;
  const y = vp.height / 2 - 260;
  await page.mouse.click(x, y);
  await page.waitForTimeout(200);
}

/** 等待画布宿主进入指定 pointer 工具状态（避免快捷键/工具切换竞态） */
export async function waitForPointer(
  page: Page,
  pointerClass: string
): Promise<void> {
  const board = page.locator('.plait-board-container');
  await expect(board).toHaveClass(new RegExp(`pointer-${pointerClass}`), {
    timeout: 5000,
  });
}

/** 用快捷键切换工具并等待生效（失败自动重按） */
export async function pressToolKey(
  page: Page,
  key: string,
  pointerClass: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press(key);
    try {
      await waitForPointer(page, pointerClass);
      return;
    } catch {
      // 焦点未就绪导致快捷键未生效，重试
      await focusCanvasEmptyArea(page);
    }
  }
  await waitForPointer(page, pointerClass);
}

/** 在画布中部绘制一个默认矩形（R 快捷键切换形状工具 -> 拖拽） */
export async function drawRectangle(page: Page): Promise<void> {
  await focusCanvasEmptyArea(page);
  await pressToolKey(page, 'r', 'rectangle');

  const { x: x1, y: y1 } = screenAt(page, -80, -40);
  const { x: x2, y: y2 } = screenAt(page, 80, 40);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 6 });
  await page.mouse.up();

  await expectElementsCreated(page);
}

/** 选中画布中部已有元素（点击视口中心） */
export async function selectCenterElement(page: Page): Promise<void> {
  const { x, y } = screenAt(page, 0, 0);
  await page.mouse.click(x, y);
  await expect(page.getByTestId('popup-toolbar')).toBeVisible({
    timeout: 10000,
  });
}

/** 通过弹出工具栏删除选中的元素 */
export async function deleteSelectedElement(
  page: Page,
  popup: Locator
): Promise<void> {
  const delBtn = popup
    .locator('button[aria-label="删除"]')
    .first()
    .or(popup.locator('[data-track*="delete"]').first());
  await expect(delBtn).toBeVisible({ timeout: 5000 });
  await delBtn.click();
  await page.waitForTimeout(600);
}
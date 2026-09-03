/**
 * 画布交互测试辅助函数
 *
 * 依赖真实 DOM 结构（recon 验证）：
 * - board-host-svg 尺寸(2560x1440)大于视口且居中 => 用「视口中心 + 偏移」定位；
 * - 工具按钮/radio 的点击方式：TDesign 风格 radio 需点击 label/容器才切换选中态；
 * - 元素插入与删除均为异步，必须用 expect.poll / toHaveCount 轮询等待。
 */
import { expect, type Locator, type Page } from '@playwright/test';

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

/** 轮询等待元素数量 > 0（元素创建是异步渲染） */
export async function expectElementsCreated(page: Page) {
  await expect
    .poll(() => elementCount(page), { timeout: 8000, intervals: [200] })
    .toBeGreaterThan(0);
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

/** 等待画布宿主进入指定 pointer 工具状态（避免快捷键竞态） */
async function waitForPointer(
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
    timeout: 5000,
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
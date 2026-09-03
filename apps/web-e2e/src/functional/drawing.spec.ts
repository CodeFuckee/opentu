/**
 * 绘制与元素编辑测试（@functional）
 *
 * 覆盖：画笔绘制、形状（Rectangle）绘制、文本插入、
 * 元素选中弹出工具栏、删除元素、撤销/重做。
 */
import { test, expect } from '../fixtures/test-base';
import {
  clickToolRadio,
  dismissInspirationBoard,
  drawRectangle,
  elementCount,
  expectElementsCreated,
  focusCanvasEmptyArea,
  pressToolKey,
  selectCenterElement,
  deleteSelectedElement,
} from '../fixtures/canvas-helpers';

test.describe('绘制与编辑', () => {
  test('画笔：绘制产生自由画笔迹元素', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });
    await dismissInspirationBoard(page);

    // 键盘 P 激活毡尖画笔（点击按钮只打开子面板，需再选笔型；键盘更稳定）。
    // 慢速环境（shell executor 宿主）下，画笔设置面板/灵感板等瞬态浮层可能
    // 在第一次 pointerdown 时拦截事件导致未落笔；允许重试落笔（最多 5 次），
    // 最终断言不变：画布上必须出现带 plait-freehand 标记的自由画笔元素。
    await focusCanvasEmptyArea(page);
    const vp = page.viewportSize() || { width: 1280, height: 720 };
    for (let attempt = 0; attempt < 5; attempt++) {
      await pressToolKey(page, 'p', 'feltTipPen');
      await page.waitForTimeout(300);

      const x1 = vp.width / 2 - 150;
      const y1 = vp.height / 2 - 80;
      const x2 = vp.width / 2 + 150;
      const y2 = vp.height / 2 + 80;
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.mouse.move(x2, y2, { steps: 12 });
      await page.mouse.up();

      try {
        await expectElementsCreated(page);
        break;
      } catch (e) {
        if (attempt === 4) {
          throw e;
        }
        // 落笔被瞬态浮层吞掉：重置焦点后重试
        await focusCanvasEmptyArea(page);
      }
    }

    // 自由画笔元素应带 plait-freehand 标记
    await expect(
      page
        .locator('.board-host-svg .element-host [plait-freehand="true"]')
        .first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('形状：绘制 Rectangle 产生几何元素并可选中', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });
    await dismissInspirationBoard(page);

    await drawRectangle(page);

    // 元素宿主中出现带 plait-geometry 的元素
    const geometry = page.locator(
      '.board-host-svg .element-host [plait-geometry="true"]'
    );
    await expect(geometry.first()).toBeVisible({ timeout: 5000 });

    // 点击元素 -> 弹出工具栏出现
    await selectCenterElement(page);
    const popup = page.getByTestId('popup-toolbar');
    // 弹出工具栏包含删除与填充等操作（分别断言避免 strict mode 多匹配）
    await expect(
      popup.getByRole('button', { name: '删除' }).first()
    ).toBeVisible();
    await expect(
      popup.getByRole('button', { name: '填充颜色' }).first()
    ).toBeVisible();
  });

  test('文本：插入并输入文本内容', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });
    await dismissInspirationBoard(page);

    // 文本工具（radio 需点击容器切换）
    const textRadio = page.getByRole('radio', { name: /文本/ }).first();
    await clickToolRadio(page, textRadio);
    await page.waitForTimeout(400);

    const vp = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.click(vp.width / 2 - 60, vp.height / 2);
    await page.waitForTimeout(500);
    await page.keyboard.type('E2E 文本测试');
    // 提交文本（点击空白处）
    await page.mouse.click(vp.width / 2 + 300, vp.height / 2 + 200);
    await page.waitForTimeout(600);

    // 文本应进入元素宿主（Slate foreignObject 内）
    await expect(
      page
        .locator('.board-host-svg .element-host')
        .getByText('E2E 文本测试')
        .first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('删除：选中元素后通过弹出工具栏删除', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });
    await dismissInspirationBoard(page);

    await drawRectangle(page);
    const countBefore = await elementCount(page);
    expect(countBefore).toBeGreaterThan(0);

    // 选中 + 删除
    await selectCenterElement(page);
    const popup = page.getByTestId('popup-toolbar');
    await deleteSelectedElement(page, popup);

    // 元素数量减少
    await expect
      .poll(async () => elementCount(page), { timeout: 8000 })
      .toBeLessThan(countBefore);
  });

  test('撤销/重做：绘制后撤销移除元素，重做恢复', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });
    await dismissInspirationBoard(page);

    await drawRectangle(page);
    const afterDraw = await elementCount(page);
    expect(afterDraw).toBeGreaterThan(0);

    // 撤销（Ctrl+Z；先聚焦画布，选中态下首次撤销可能只清除选中，需可重试轮询）
    await focusCanvasEmptyArea(page);
    const pressUndo = async () => {
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Control+z');
        try {
          await expect
            .poll(async () => elementCount(page), { timeout: 3000, intervals: [200] })
            .toBeLessThan(afterDraw);
          return;
        } catch {
          // 继续按撤销
        }
      }
      throw new Error('多次 Ctrl+Z 后元素数量未减少');
    };
    await pressUndo();

    // 重做（Ctrl+Shift+Z；同样轮询+重试）
    await page.keyboard.press('Control+Shift+z');
    await expect
      .poll(async () => elementCount(page), { timeout: 8000 })
      .toBe(afterDraw);
  });
});
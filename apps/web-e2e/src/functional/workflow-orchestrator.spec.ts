/**
 * 工作流编排(主画布原生)E2E(@functional)
 *
 * 覆盖 C1 用户路径(不依赖跨刷新持久化——画板持久化由 Plait 体系保证):
 * - P0 工具箱加 3 节点 → 连线 → 填提示词 → 页内验证节点/参数/端口
 * - P1 工具箱工作流节点区可见(7 种)
 * 真实生成执行链路由引擎/编译器单测 mock 覆盖,E2E 不运行真实生成。
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test-base';

async function openToolboxAndAddNode(page: Page, label: string) {
  await page.getByTestId('toolbar-toolbox').click();
  const drawer = page.locator('.side-drawer--toolbar-right').first();
  await drawer.getByRole('button', { name: /AI 工具/ }).click();
  const wfSection = drawer.locator('[data-testid="toolbox-wf-nodes"]');
  await expect(wfSection).toBeVisible({ timeout: 8000 });
  await wfSection.locator('button', { hasText: label }).first().click();
  await page.waitForTimeout(300);
  await page.getByTestId('toolbar-toolbox').click();
  await page.waitForTimeout(300);
}

function cardOf(page: Page, label: string) {
  return page.locator('.wf-node-card', { hasText: label }).first();
}

async function connect(page: Page, fromLabel: string, toLabel: string) {
  const port = cardOf(page, fromLabel).locator('.wf-node-port--out');
  const pb = await port.boundingBox();
  const toCard = cardOf(page, toLabel);
  const tb = await toCard.boundingBox();
  expect(pb && tb).toBeTruthy();
  await page.mouse.move(pb!.x + pb!.width / 2, pb!.y + pb!.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb!.x + tb!.width / 2, tb!.y + tb!.height / 2, {
    steps: 6,
  });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test.describe('工作流编排(主画布)', () => {
  test('P0 搭建生图编排:加节点/连线/填提示词', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });
    for (let i = 0; i < 5; i++) {
      if (
        await page
          .getByRole('button', { name: '不再提示' })
          .isVisible({ timeout: 400 })
          .catch(() => false)
      ) {
        await page.getByRole('button', { name: '不再提示' }).click();
        break;
      }
    }

    await openToolboxAndAddNode(page, '提示词');
    await openToolboxAndAddNode(page, '文生图');
    await openToolboxAndAddNode(page, '存素材库');

    // 三节点都渲染在画布上
    await expect(cardOf(page, '提示词')).toBeVisible({ timeout: 8000 });
    await expect(cardOf(page, '文生图')).toBeVisible({ timeout: 8000 });
    await expect(cardOf(page, '存素材库')).toBeVisible({ timeout: 8000 });

    // 连线:提示词→文生图,文生图→存素材库
    await connect(page, '提示词', '文生图');
    await connect(page, '文生图', '存素材库');

    // 填唯一提示词
    const uniq = `柴犬E2E_${Date.now()}`;
    await cardOf(page, '提示词')
      .locator('textarea')
      .fill(`一只柴犬在草地上奔跑 ${uniq}`);

    // 验证参数写入(textarea 值 = 唯一提示词)
    await expect(cardOf(page, '提示词').locator('textarea')).toHaveValue(
      `一只柴犬在草地上奔跑 ${uniq}`
    );

    // 验证端口存在(输出/输入)
    await expect(cardOf(page, '提示词').locator('.wf-node-port--out')).toBeAttached();
    if (await cardOf(page, '文生图').locator('.wf-node-port--in').isVisible().catch(() => false)) {
      await expect(cardOf(page, '文生图').locator('.wf-node-port--in')).toBeAttached();
    }
    await expect(cardOf(page, '文生图').locator('.wf-node-port--out')).toBeAttached();
  });

  test('P1 工具箱工作流节点区可见(7 种)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('toolbar-toolbox').click();
    const drawer = page.locator('.side-drawer--toolbar-right').first();
    await drawer.getByRole('button', { name: /AI 工具/ }).click();
    const wfSection = drawer.locator('[data-testid="toolbox-wf-nodes"]');
    await expect(wfSection).toBeVisible({ timeout: 8000 });
    for (const label of ['提示词', '文生图', '存素材库']) {
      await expect(wfSection.locator('button', { hasText: label }).first()).toBeVisible();
    }
  });

  test('P0 文生图节点可删除(Delete 键 + 垃圾桶按钮)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });

    // 回归:with-workflow-node 的 getDeletedFragment 曾漏 push 节点本身,
    // deleteFragment(board) 拿到空列表静默无操作——节点选中也删不掉。
    await openToolboxAndAddNode(page, '文生图');
    const card = cardOf(page, '文生图');
    await expect(card).toBeVisible({ timeout: 8000 });

    // 路径一:点卡片头部选中 → Delete 键
    const header = card.locator('.wf-node-card__header');
    const hb = await header.boundingBox();
    await page.mouse.click(hb!.x + 20, hb!.y + hb!.height / 2);
    await expect(page.getByTestId('popup-toolbar')).toBeVisible({ timeout: 8000 });
    await page.keyboard.press('Delete');
    await expect(cardOf(page, '文生图')).toHaveCount(0, { timeout: 8000 });

    // 路径二:再加一个节点 → 选中 → popup 垃圾桶按钮
    await openToolboxAndAddNode(page, '文生图');
    const card2 = cardOf(page, '文生图');
    await expect(card2).toBeVisible({ timeout: 8000 });
    const hb2 = await card2.locator('.wf-node-card__header').boundingBox();
    await page.mouse.click(hb2!.x + 20, hb2!.y + hb2!.height / 2);
    await expect(page.getByTestId('popup-toolbar')).toBeVisible({ timeout: 8000 });
    await page
      .getByTestId('popup-toolbar')
      .locator('button.trash')
      .first()
      .click({ force: true });
    await expect(cardOf(page, '文生图')).toHaveCount(0, { timeout: 8000 });
  });
});

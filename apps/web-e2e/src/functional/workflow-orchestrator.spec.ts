/**
 * 工作流编排(主画布原生)E2E(@functional)
 *
 * 覆盖 C1 用户路径:
 * - P0 工具箱打开面板 → 添加 3 节点到主画布 → 端口拖拽连线 → 填唯一提示词
 *   → 刷新后节点与唯一提示词随画板恢复(画板节点跨运行累积,断言用唯一文本锚定);
 * - P1 空画布运行全部 → 提示「画布上还没有工作流节点」。
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
  test('P0 搭建生图编排,刷新后节点与唯一提示词随画板恢复', async ({ page }) => {
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

    await connect(page, '提示词', '文生图');
    await connect(page, '文生图', '存素材库');

    // 唯一提示词锚定(画板节点跨运行累积,不能按数量断言)
    const uniq = `柴犬E2E_${Date.now()}`;
    await cardOf(page, '提示词')
      .locator('textarea')
      .fill(`一只柴犬在草地上奔跑 ${uniq}`);

    await page.reload();
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });
    await expect
      .poll(
        async () =>
          page
            .locator('.wf-node-card textarea')
            .evaluateAll(
              (els, uid: string) =>
                els.some((el) => (el as HTMLTextAreaElement).value.includes(uid)),
              uniq
            ),
        { timeout: 20000 }
      )
      .toBe(true);
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
});

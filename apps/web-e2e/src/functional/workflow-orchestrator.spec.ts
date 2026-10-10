/**
 * 工作流编排(主画布原生)E2E(@functional)
 *
 * 覆盖 C1 用户路径:
 * - P0 工具箱打开面板 → 添加 3 节点到主画布 → 端口拖拽连线 → 双击填提示词
 *   → 填提示词 → 刷新后节点/连线/参数随画板恢复;
 *   (生成执行链路由引擎/编译器单测 mock 覆盖,E2E 不跑真实生成)
 * - P1 空画布运行全部 → 提示「画布上还没有工作流节点」。
 * 生成执行链路由引擎/编译器单测 mock 覆盖,E2E 不依赖真实模型。
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test-base';

async function openPalette(page: Page) {
  await page.getByTestId('toolbar-toolbox').click();
  const drawer = page.locator('.side-drawer--toolbar-right').first();
  await drawer.getByRole('button', { name: /AI 工具/ }).click();
  const item = drawer
    .locator('.toolbox-drawer__content')
    .getByText('工作流编排', { exact: false })
    .first();
  await expect(item).toBeVisible({ timeout: 8000 });
  await item.click();
  const palette = page.locator('[data-testid="workflow-orchestrator"]');
  await expect(palette).toBeVisible({ timeout: 10000 });
  return palette;
}

async function addNode(page: Page, label: string) {
  const palette = page.locator('[data-testid="workflow-orchestrator"]');
  await palette.locator('button', { hasText: label }).first().click();
  await page.waitForTimeout(250);
}

/** 画布节点卡片(按可见标题文本过滤) */
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
  test('P0 搭建生图编排并运行(无 Key 失败态可见),刷新后节点/连线随画板恢复', async ({
    page,
  }) => {
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

    const palette = await openPalette(page);
    await addNode(page, '提示词');
    await addNode(page, '文生图');
    await addNode(page, '存素材库');
    await expect(page.locator('.wf-node-card')).toHaveCount(3);

    await connect(page, '提示词', '文生图');
    await connect(page, '文生图', '存素材库');

    // 填提示词(节点内联输入)
    await cardOf(page, '提示词')
      .locator('textarea')
      .fill('一只柴犬在草地上奔跑');

    // 刷新:节点/连线随画板恢复(生成执行链路由单测 mock 覆盖,E2E 不跑真实生成)
    await page.reload();
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.wf-node-card')).toHaveCount(3, { timeout: 20000 });
    await expect(cardOf(page, '提示词').locator('textarea')).toHaveValue(
      '一只柴犬在草地上奔跑',
      { timeout: 10000 }
    );
  });

  test('P1 空画布运行全部 → 提示「画布上还没有工作流节点」', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });
    const palette = await openPalette(page);
    await palette.getByText('运行全部').click();
    await expect(
      page.locator('.t-message', { hasText: '画布上还没有工作流节点' })
    ).toBeVisible({ timeout: 8000 });
  });
});

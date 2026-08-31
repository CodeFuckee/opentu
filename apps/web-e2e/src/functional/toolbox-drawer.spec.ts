/**
 * 工具箱抽屉测试（@functional）
 *
 * 覆盖：工具箱打开、分类切换（全部/AI工具/内容工具/实用工具）、关闭。
 */
import { test, expect } from '../fixtures/test-base';

test.describe('工具箱抽屉', () => {
  async function openToolbox(page: import('@playwright/test').Page) {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('toolbar-toolbox').click();
    const drawer = page.locator('.side-drawer--toolbar-right').first();
    await expect(drawer).toBeVisible({ timeout: 8000 });
    await expect(drawer).toContainText('工具箱');
    return drawer;
  }

  test('打开工具箱并展示分类', async ({ page }) => {
    const drawer = await openToolbox(page);

    await expect(drawer.getByRole('button', { name: '全部' })).toBeVisible();
    await expect(
      drawer.getByRole('button', { name: /AI 工具/ })
    ).toBeVisible();
    await expect(
      drawer.getByRole('button', { name: /内容工具/ })
    ).toBeVisible();
    await expect(
      drawer.getByRole('button', { name: /实用工具/ })
    ).toBeVisible();
  });

  test('分类切换：AI 工具展示 AI 工具列表', async ({ page }) => {
    const drawer = await openToolbox(page);

    await drawer.getByRole('button', { name: /AI 工具/ }).click();
    await page.waitForTimeout(600);

    // 抽屉内容区应出现 AI 工具项
    const content = drawer.locator('.toolbox-drawer__content').first();
    await expect(content).toContainText('多图生成', { timeout: 5000 });
    await expect(content).toContainText('爆款视频生成');

    // 切回全部：内容工具与实用工具回归
    await drawer.getByRole('button', { name: '全部' }).click();
    await page.waitForTimeout(400);
    await expect(content).toContainText('我的提示词', { timeout: 5000 });
    await expect(content).toContainText('知识库');
  });

  test('关闭工具箱抽屉', async ({ page }) => {
    const drawer = await openToolbox(page);

    await page.getByTestId('toolbar-toolbox').click();
    await expect(drawer).toBeHidden({ timeout: 5000 });
  });
});

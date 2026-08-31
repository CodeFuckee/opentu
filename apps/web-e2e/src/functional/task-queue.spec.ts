/**
 * 任务队列面板测试（@functional）
 *
 * 覆盖：任务队列展开/收起、状态标签（全部/生成中/失败/已完成/历史）、空态。
 */
import { test, expect } from '../fixtures/test-base';

test.describe('任务队列', () => {
  test('展开任务队列并展示状态标签与空态', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId('toolbar-tasks').click();
    await page.waitForTimeout(700);

    const panel = page.getByTestId('task-queue-panel');
    await expect(panel).toBeVisible({ timeout: 8000 });

    // 状态标签
    const bodyText = await page.evaluate(() =>
      (document.body.innerText || '').replace(/\n+/g, '|')
    );
    expect(bodyText).toMatch(/全部/);
    expect(bodyText).toMatch(/生成中/);
    expect(bodyText).toMatch(/失败/);
    expect(bodyText).toMatch(/已完成/);

    // 新账号无任务 -> 空态
    expect(bodyText).toContain('暂无任务');
  });

  test('收起任务队列', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId('toolbar-tasks').click();
    const panel = page.getByTestId('task-queue-panel');
    await expect(panel).toBeVisible({ timeout: 8000 });

    await page.getByTestId('toolbar-tasks').click();
    await expect(panel).toBeHidden({ timeout: 5000 });
  });
});
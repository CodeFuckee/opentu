/**
 * 灵感创意板测试（@functional）
 *
 * 覆盖：空画布时灵感板展示、模板点击填充提示词、发送引导、返回恢复模板列表。
 */
import { test, expect } from '../fixtures/test-base';
import { disableCloudPullForLocalIsolation } from '../fixtures/cloud-sync-helpers';
import type { Page } from '@playwright/test';

const aiTextarea = (page: Page) => page.getByTestId('ai-input-textarea');

// 灵感板断言「空画布」初始态——登录云拉取会带入共享账号池的云端画布，本地隔离
test.beforeEach(async ({ page }) => {
  await disableCloudPullForLocalIsolation(page);
});

test.describe('灵感创意板', () => {
  test('空画布展示灵感板与模板', async ({ page }) => {
    await page.goto('/');

    const board = page.getByTestId('inspiration-board');
    await expect(board).toBeVisible({ timeout: 15000 });

    await expect(
      page.getByRole('heading', { name: '灵感创意', level: 3 })
    ).toBeVisible();

    // 模板卡片
    await expect(
      board.getByRole('heading', { name: '智能拆分宫格图', level: 3 })
    ).toBeVisible();
    await expect(
      board.getByRole('heading', { name: '生成PPT大纲', level: 3 })
    ).toBeVisible();
  });

  test('点击模板：提示词自动填充并显示发送引导，可返回', async ({ page }) => {
    await page.goto('/');
    const board = page.getByTestId('inspiration-board');
    await expect(board).toBeVisible({ timeout: 15000 });

    const firstCard = board.getByRole('heading', {
      name: '智能拆分宫格图',
      level: 3,
    });
    await firstCard.click();
    await page.waitForTimeout(600);

    // 提示词已填充
    await expect(aiTextarea(page)).toHaveValue('生成16宫格猫咪表情包');

    // 发送引导出现
    const sendGuide = page.getByTestId('inspiration-send-guide');
    await expect(sendGuide).toBeVisible();
    // 引导提示文案
    await expect(
      sendGuide.getByText('下一步：点击发送按钮开始生成')
    ).toBeVisible();
    // 标题“确认后发送”在灵感板头部
    await expect(
      board.getByRole('heading', { name: '确认后发送', level: 3 })
    ).toBeVisible();

    // 返回：恢复模板列表
    await page.getByTestId('inspiration-guide-back').click();
    await expect(sendGuide).toBeHidden();
    await expect(
      board.getByRole('heading', { name: '生成PPT大纲', level: 3 })
    ).toBeVisible();
  });

  test('不再提示：可关闭灵感板', async ({ page }) => {
    await page.goto('/');
    const board = page.getByTestId('inspiration-board');
    await expect(board).toBeVisible({ timeout: 15000 });

    const hide = page.locator('[data-track="inspiration_click_hide"]').first();
    await hide.click({ force: true });
    await expect(board).toBeHidden({ timeout: 5000 });
  });
});
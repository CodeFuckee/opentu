/**
 * 聊天抽屉测试（@functional）
 *
 * 覆盖：聊天抽屉展开/收起、新对话、会话列表、模型选择器、输入区。
 */
import { test, expect } from '../fixtures/test-base';

test.describe('聊天抽屉', () => {
  test('展开聊天抽屉并展示会话结构', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    const openBtn = page.locator('[data-track="chat_click_drawer_open"]');
    await expect(openBtn.first()).toBeVisible();
    await openBtn.first().click();
    await page.waitForTimeout(800);

    const drawer = page.getByTestId('chat-drawer');
    await expect(drawer).toBeVisible({ timeout: 8000 });

    // 新对话按钮
    await expect(
      drawer.locator('[data-track="chat_click_new_session"]')
    ).toBeVisible();
    // 会话列表切换
    await expect(
      drawer.locator('[data-track="chat_click_sessions_toggle"]')
    ).toBeVisible();
    // 输入区（textarea）
    await expect(
      drawer.locator('.enhanced-chat-input__textarea').first()
    ).toBeVisible();

    // 收起
    const closeBtn = drawer.locator('[data-track="chat_click_drawer_close"]');
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click();
      await page.waitForTimeout(600);
      await expect(drawer).toBeHidden({ timeout: 5000 });
    }
  });

  test('新对话：点击创建空对话', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    await page.locator('[data-track="chat_click_drawer_open"]').first().click();
    await page.waitForTimeout(800);
    const drawer = page.getByTestId('chat-drawer');
    await expect(drawer).toBeVisible({ timeout: 8000 });

    await drawer
      .locator('[data-track="chat_click_new_session"]')
      .first()
      .click();
    await page.waitForTimeout(600);

    // 新会话应出现“开始对话”引导文案
    await expect(
      drawer.getByText('开始对话').first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('聊天模型选择器存在', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    await page.locator('[data-track="chat_click_drawer_open"]').first().click();
    await page.waitForTimeout(800);
    const drawer = page.getByTestId('chat-drawer');
    await expect(drawer).toBeVisible({ timeout: 8000 });

    const modelSel = drawer.locator(
      '[data-track="chat_click_model_selector"]'
    );
    await expect(modelSel.first()).toBeVisible();
  });
});
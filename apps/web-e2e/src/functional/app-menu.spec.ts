/**
 * 应用菜单与对话框测试（@functional）
 *
 * 覆盖：应用菜单（打开/保存/导出/清除/设置/备份恢复 等）、
 * 设置对话框（WinBox 窗口）、备份恢复对话框。
 */
import { test, expect } from '../fixtures/test-base';

test.describe('应用菜单', () => {
  async function openAppMenu(page: import('@playwright/test').Page) {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: /应用菜单/ }).first().click();
    await page.waitForTimeout(500);
  }

  test('菜单包含核心文件操作项', async ({ page }) => {
    await openAppMenu(page);

    const menuItems = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="menuitem"]'))
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
        .filter(Boolean)
    );
    expect(menuItems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/打开/),
        expect.stringMatching(/保存/),
        expect.stringMatching(/导出/),
        expect.stringMatching(/清除|备份/),
        expect.stringMatching(/备份/),
        expect.stringMatching(/设置/),
      ])
    );

    await page.keyboard.press('Escape');
  });

  test('设置对话框：打开并关闭', async ({ page }) => {
    await openAppMenu(page);

    const settings = page
      .locator('[data-track="toolbar_click_menu_settings"]')
      .first();
    await settings.click();
    await page.waitForTimeout(800);

    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible({ timeout: 8000 });

    // WinBox 窗口的关闭按钮
    const closeBtn = page.locator(
      '.winbox-settings-window .wb-close'
    );
    await expect(closeBtn).toBeVisible({ timeout: 5000 });
    await closeBtn.click();
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });

  test('备份恢复对话框：打开并关闭', async ({ page }) => {
    await openAppMenu(page);

    const backup = page
      .locator('[data-track="toolbar_click_menu_backup"]')
      .first();
    await backup.click();
    await page.waitForTimeout(800);

    const dialog = page.getByTestId('backup-restore-dialog');
    await expect(dialog).toBeVisible({ timeout: 8000 });

    // 含导出备份与恢复能力
    await expect(dialog.getByText(/导出备份|导出/).first()).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });
});
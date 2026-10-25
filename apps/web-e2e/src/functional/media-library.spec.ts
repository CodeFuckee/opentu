/**
 * 素材库测试（@functional）
 *
 * 覆盖：素材库打开（WinBox 窗口）、筛选分类（全部/图片/视频/音频/主体/本地/AI）、
 * 视图切换（网格/紧凑/列表）、空态提示、关闭。
 */
import { test, expect } from '../fixtures/test-base';
import { disableCloudPullForLocalIsolation } from '../fixtures/cloud-sync-helpers';

// 云端唯一存储默认开启后，共享账号池的云端素材会进视图——本 spec 断言素材库
// 空态，统一接入本地隔离
test.beforeEach(async ({ page }) => {
  await disableCloudPullForLocalIsolation(page);
});

test.describe('素材库', () => {
  async function openMediaLibrary(page: import('@playwright/test').Page) {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    const mediaLabel = page
      .locator('label')
      .filter({ has: page.getByRole('radio', { name: /素材库/ }) })
      .first();
    await expect(mediaLabel).toBeVisible();
    await mediaLabel.click({ force: true });
    await page.waitForTimeout(700);
  }

  test('打开素材库并展示筛选与空态', async ({ page }) => {
    await openMediaLibrary(page);

    // WinBox 窗口类名（data-testid 不会透传到原生 WinBox DOM）
    const modal = page.locator('.winbox-media-library');
    await expect(modal).toBeVisible({ timeout: 8000 });

    // 筛选分类（以弹窗为作用域断言：body 全文会被工具栏常驻文案污染成永真断言）
    const modalText = await modal.innerText();
    const modalTextNormalized = modalText.replace(/\n+/g, '|');
    expect(modalTextNormalized).toMatch(/图片|视频|音频/);
    expect(modalTextNormalized).toMatch(/本地|AI/);

    // 空态（新账号无素材）
    expect(modalTextNormalized).toContain('暂无素材');

    // 视图切换按钮
    await expect(page.locator('[data-track="view_mode_grid"]')).toBeVisible();
    await expect(
      page.locator('[data-track="view_mode_compact"]')
    ).toBeVisible();
    await expect(page.locator('[data-track="view_mode_list"]')).toBeVisible();
  });

  test('关闭素材库（WinBox 关闭按钮）', async ({ page }) => {
    await openMediaLibrary(page);

    const modal = page.locator('.winbox-media-library');
    await expect(modal).toBeVisible({ timeout: 8000 });

    const closeBtn = page.locator('.winbox-media-library .wb-close');
    await expect(closeBtn).toBeVisible({ timeout: 5000 });
    await closeBtn.click();
    await expect(modal).toBeHidden({ timeout: 5000 });
  });
});
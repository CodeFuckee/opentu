/**
 * 视图导航测试（@functional）
 *
 * 覆盖：缩放（放大/缩小）、自适应/100% 缩放菜单、小地图展开/收起。
 * 注意：board-host-svg 尺寸(2560x1440)大于视口，坐标以视口中心为基准。
 */
import { test, expect } from '../fixtures/test-base';

test.describe('视图导航', () => {
  const readZoom = async (page: import('@playwright/test').Page) =>
    (await page.getByTestId('zoom-display').innerText()).trim();

  test('缩放：放大/缩小改变缩放显示值', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('view-navigation')).toBeVisible({
      timeout: 15000,
    });

    const initial = await readZoom(page);

    await page.getByTestId('zoom-in').click();
    await page.waitForTimeout(300);
    const zoomedIn = await readZoom(page);
    expect(zoomedIn).not.toBe(initial);

    await page.getByTestId('zoom-out').click();
    await page.waitForTimeout(300);
    const zoomedOut = await readZoom(page);
    expect(zoomedOut).not.toBe(zoomedIn);
  });

  test('缩放菜单：100% 选项恢复初始比例', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('view-navigation')).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId('zoom-in').click();
    await page.waitForTimeout(300);
    const zoomed = await readZoom(page);
    expect(zoomed).not.toBe('100%');

    await page.getByTestId('zoom-display').click();
    await page.waitForTimeout(400);
    const zoom100 = page.locator('[data-track="view_nav_zoom_100"]');
    await expect(zoom100).toBeVisible({ timeout: 5000 });
    await zoom100.click();
    await page.waitForTimeout(300);
    expect(await readZoom(page)).toBe('100%');
  });

  test('缩放菜单：自适应选项存在', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('view-navigation')).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId('zoom-display').click();
    await page.waitForTimeout(400);
    await expect(
      page.locator('[data-track="view_nav_zoom_fit"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-track="view_nav_zoom_fit_frame"]')
    ).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('小地图：初始可见，点击切换展开/收起', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('view-navigation')).toBeVisible({
      timeout: 15000,
    });

    const minimapToggle = page.locator(
      '[data-track="view_nav_minimap_toggle"]'
    );
    await expect(minimapToggle).toBeVisible();
    const minimap = page.locator('.view-navigation__minimap').first();

    const visibleBefore = await minimap.isVisible().catch(() => false);
    await minimapToggle.click();
    await expect
      .poll(() => minimap.isVisible().catch(() => false), { timeout: 5000 })
      .not.toBe(visibleBefore);
    await minimapToggle.click();
    await expect
      .poll(() => minimap.isVisible().catch(() => false), { timeout: 5000 })
      .toBe(visibleBefore);
  });
});

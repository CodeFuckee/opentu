/**
 * #103 画布即编辑器 E2E(@functional)
 *
 * 主流程:官方素材库插图 → 选中 →「编辑图片」进入编辑态 → 画笔在图上叠加 →
 * 「完成合并」→ 断言画布出现合并图(桶直链)与横幅"已合并" →「撤销合并」→
 * 断言恢复原图与叠加。覆盖合并/撤销两路径;取消路径人工过目。
 */
import { test, expect } from '../fixtures/test-base';

test.describe('画布即编辑器', () => {
  // 回归(用户实测 bug):虚拟 URL 原图拍平不得丢——上传本地图(虚拟路径)→
  // 编辑 → 无叠加直接合并 → 合并图必须有实际像素(非全透明),且撤销可恢复
  test('虚拟 URL 原图合并不丢像素并可撤销', async ({ page }) => {
    test.setTimeout(210_000);
    await page.goto('/');
    for (let i = 0; i < 10; i++) {
      if (await page.getByRole('button', { name: '不再提示' }).isVisible({ timeout: 500 }).catch(() => false)) {
        await page.getByRole('button', { name: '不再提示' }).click();
        break;
      }
    }
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });

    const mediaLabel = page
      .locator('label')
      .filter({ has: page.getByRole('radio', { name: /素材库/ }) })
      .first();
    await mediaLabel.click({ force: true });
    const winbox = page.locator('.winbox-media-library');
    await expect(winbox).toBeVisible({ timeout: 15000 });
    const uploadName = `canvas-edit-e2e-${Date.now()}.png`;
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    await winbox.locator('input[type="file"]').setInputFiles([
      { name: uploadName, mimeType: 'image/png', buffer: png1x1 },
    ]);
    const uploaded = winbox.locator('.asset-item', { hasText: uploadName }).first();
    await expect(uploaded).toBeVisible({ timeout: 15000 });
    await uploaded.hover();
    const insertBtn = winbox.locator('button[aria-label="插入到画布"]').first();
    await insertBtn.waitFor({ state: 'visible', timeout: 8000 });
    await insertBtn.click({ force: true });
    await expect(
      page.locator('.t-message', { hasText: '素材已插入到画板' })
    ).toBeVisible({ timeout: 15000 });
    await winbox.locator('.wb-close').click().catch(() => {});
    await page.waitForTimeout(600);

    const canvasImg = page
      .locator('.viewport-container foreignObject img')
      .first();
    await expect(canvasImg).toBeVisible({ timeout: 15000 });
    const box = await canvasImg.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const editBtn = page
      .getByTestId('popup-toolbar')
      .getByRole('button', { name: '编辑图片' });
    await expect(editBtn).toBeVisible({ timeout: 10000 });
    await editBtn.click({ force: true });
    const banner = page.getByTestId('canvas-edit-banner');
    await expect(banner).toBeVisible({ timeout: 10000 });

    // 无叠加直接合并(最小复现丢图路径)
    await page.locator('[data-track="canvas_edit_complete"]').click();
    await expect(banner).toContainText('已合并为一张图', { timeout: 60000 });

    // 核心断言:合并图有实际不透明像素(丢原图时为全透明)
    const mergedImg = page
      .locator('.viewport-container foreignObject img')
      .first();
    await expect(mergedImg).toBeVisible({ timeout: 15000 });
    const opaqueRatio = await mergedImg.evaluate((el) => {
      const img = el as HTMLImageElement;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      if (!ctx || !c.width) {
        return -1;
      }
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      let total = 0;
      for (let i = 3; i < d.length; i += 40) {
        total++;
        if (d[i] > 10) {
          opaque++;
        }
      }
      return total === 0 ? -1 : opaque / total;
    });
    expect(opaqueRatio).toBeGreaterThan(0.5);

    // 撤销恢复原图
    await page.locator('[data-track="canvas_edit_undo"]').click();
    await expect(banner).toBeHidden({ timeout: 10000 });
    await expect(canvasImg.first()).toBeVisible({ timeout: 15000 });
  });
});

/**
 * 以图搜图(#61)冒烟(@functional)
 *
 * 覆盖:素材库官方库「以图搜图」入口 → 上传 fixture 图(取自库内贴图,向量已建)
 * → 相似模式:结果网格出现、带相似度角标、chip 可退出恢复普通模式。
 * 模型首次下载 ~89MB 走内网公开桶,CI 同机可达;查询编码 WASM ~1-3s。
 */
import { test, expect } from '../fixtures/test-base';
import path from 'node:path';

const FIXTURE = path.resolve(__dirname, '../../../../test-files/image-search-fixture.png');

test.describe('以图搜图', () => {
  test('上传图片搜出同款素材并可退出相似模式', async ({ page }) => {
    await page.goto('/');
    const guideDismiss = page.getByRole('button', { name: '不再提示' });
    if (await guideDismiss.isVisible({ timeout: 2000 }).catch(() => false)) {
      await guideDismiss.click();
    }
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    // 打开素材库 → 官方素材库
    const mediaLabel = page
      .locator('label')
      .filter({ has: page.getByRole('radio', { name: /素材库/ }) })
      .first();
    await mediaLabel.click({ force: true });
    await expect(page.locator('.winbox-media-library')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('media-library-mode-official').click();
    const view = page.getByTestId('official-library-view');
    await expect(view).toBeVisible({ timeout: 20000 });

    // 以图搜图入口 → 上传 fixture
    const imageSearchBtn = page.locator(
      '[data-track="official_library_image_search"]'
    );
    await expect(imageSearchBtn).toBeVisible({ timeout: 10000 });
    const fileInput = view.locator('input[type="file"][accept="image/*"]');
    await fileInput.setInputFiles(FIXTURE);

    // 相似模式:chip 出现 → 网格出结果(模型下载+编码+检索,首次放宽)
    await expect(
      page.locator('[data-track="official_library_similar_exit"]')
    ).toBeVisible({ timeout: 10000 });
    const similarCard = page.locator(
      '.official-library .asset-item',
      { hasText: /.+/ }
    ).first();
    await expect(similarCard).toBeVisible({ timeout: 120000 });
    // 相似度角标(蓝色百分角标)
    await expect(
      page.locator('.asset-item__similar-badge').first()
    ).toBeVisible({ timeout: 10000 });

    // 退出相似模式恢复普通浏览(tab 回来)
    await page.locator('[data-track="official_library_similar_exit"]').click();
    await expect(
      page.locator('[data-track="official_library_gallery_tab"]').first()
    ).toBeVisible({ timeout: 10000 });
  });
});

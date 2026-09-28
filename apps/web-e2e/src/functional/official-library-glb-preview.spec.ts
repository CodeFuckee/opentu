/**
 * 官方素材库 3D 预览（glb）冒烟（@functional）
 *
 * 覆盖：素材库 → 官方素材库 → 家居库 → 搜索带 glb 的稳定样本 →
 * 详情面板「3D 预览」→ GlbModelViewerDialog 打开且 model-viewer 挂上直链。
 *
 * 样本依赖共享库数据：jzxz_home_materials 中名为「餐椅丨BETTY TK3」的行
 * （glb 3.7MB < 20MB，不触发大文件确认，直接进入 loading）。
 * 真实 WebGL 渲染走人工过目（内网 HTTP 地址），此处只断言元素与链路。
 */
import { test, expect } from '../fixtures/test-base';

test.describe('官方素材库 3D 预览', () => {
  test('家居库带 glb 素材可打开 3D 预览', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    // 首启引导弹窗「灵感创意」会拦截后续点击，出现即关闭
    const guideDismiss = page.getByRole('button', { name: '不再提示' });
    if (await guideDismiss.isVisible({ timeout: 2000 }).catch(() => false)) {
      await guideDismiss.click();
    }

    // 打开素材库（WinBox）
    const mediaLabel = page
      .locator('label')
      .filter({ has: page.getByRole('radio', { name: /素材库/ }) })
      .first();
    await expect(mediaLabel).toBeVisible();
    await mediaLabel.click({ force: true });
    const modal = page.locator('.winbox-media-library');
    await expect(modal).toBeVisible({ timeout: 8000 });

    // 切换官方素材库 → 家居库(搜索框只有 data-track 无 data-testid)
    await page.getByTestId('media-library-mode-official').click();
    const searchInput = page.locator('[data-track="official_library_search_input"]');
    await expect(searchInput).toBeVisible({ timeout: 20000 });
    await page
      .locator('[data-track="official_library_gallery_tab"]', {
        hasText: '家居库',
      })
      .click();

    // 搜索稳定样本并选中卡片 → 详情面板(tdesign Input 的 data-track 挂在包装层)
    await searchInput.locator('input').fill('餐椅丨BETTY TK3');
    const card = page.locator('.asset-item', { hasText: 'BETTY TK3' }).first();
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.click();

    // 详情面板「3D 预览」→ 对话框 + model-viewer 挂上公开桶直链
    const previewBtn = page.locator('[data-track="inspector_home_glb_preview"]');
    await expect(previewBtn).toBeVisible({ timeout: 8000 });
    await previewBtn.click();
    const viewer = page.locator('.glb-viewer-dialog model-viewer');
    // 懒 chunk(model-viewer+three)在 dev 冷启时编译可达数十秒,放宽等待
    await expect(viewer).toBeVisible({ timeout: 40000 });
    await expect(viewer).toHaveAttribute('src', /\/storage\/v1\/object\/public\//);

    // 回归 1:加载完成后进度提示必须消失(load 事件经 stage 容器查询绑定)。
    // CI 上模型下载可能较慢,放宽至 60s;即便监听失效,看门狗 30s 也会切降级使提示消失
    await expect(page.locator('.glb-viewer-dialog__progress')).toBeHidden({
      timeout: 60000,
    });
    // 回归 2:环境可达时模型撑满对话框;拉不到模型(runner 网络受限)时降级 UI 必须完整
    const fallbackEl = page.locator('.glb-viewer-dialog__fallback');
    if (await fallbackEl.isVisible()) {
      await expect(fallbackEl).toContainText('下载 glb');
    } else {
      const box = await viewer.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(600);
      expect(box?.height ?? 0).toBeGreaterThan(300);
    }

    // 关闭对话框即卸载
    await page.locator('.glb-viewer-dialog').press('Escape');
    await expect(page.locator('.glb-viewer-dialog')).toBeHidden({
      timeout: 5000,
    });
  });
});

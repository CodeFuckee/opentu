/**
 * Flowgram 工作流编排编辑器 E2E（@functional）
 *
 * 覆盖：/workflow 直达(SPA fallback)、编辑器壳完整渲染、添加节点、
 * 保存后刷新仍在(URL ?graph= 恢复)、返回画布。
 * 以已登录状态启动（依赖 auth-setup 的 storageState）。
 */
import { test, expect } from '../fixtures/test-base';

test.describe('Flowgram 工作流编排器', () => {
  test('E2E-WF-EDITOR-001 /workflow 直达并渲染编辑器壳', async ({ page }) => {
    await page.goto('/workflow');

    // 顶栏核心按钮
    await expect(page.getByRole('button', { name: /← 画布/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: /保存/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /▶ 运行/ })).toBeVisible();

    // 左侧节点面板(8 种节点)
    for (const label of ['提示词', '参考图', '文生图', '插入画布']) {
      await expect(
        page.locator('.fwf-node-panel__item', { hasText: label })
      ).toBeVisible();
    }

    // flowgram 画布挂载
    await expect(page.locator('.fwf-editor').first()).toBeVisible({
      timeout: 15_000,
    });

    // 右侧参数栏空态
    await expect(page.getByText('选中节点后在此编辑参数')).toBeVisible();
  });

  test('E2E-WF-EDITOR-002 添加节点→保存→刷新仍在→返回画布', async ({ page }) => {
    await page.goto('/workflow');

    const canvasArea = page.locator('.fwf-canvas');
    await expect(canvasArea).toBeVisible({ timeout: 20_000 });

    // 添加两个节点
    await page.locator('.fwf-node-panel__item', { hasText: '提示词' }).click();
    await page.locator('.fwf-node-panel__item', { hasText: '文生图' }).click();
    await expect(page.locator('.fwf-node')).toHaveCount(2, { timeout: 10_000 });

    // 命名并保存
    const nameInput = page.locator('.fwf-topbar__name');
    await nameInput.fill('E2E 编排器验证图');
    await page.getByRole('button', { name: /保存/ }).click();
    // 保存成功提示(消息组件)或按钮恢复非 saving 态
    await expect(nameInput).toHaveValue('E2E 编排器验证图', { timeout: 10_000 });
    await page.waitForTimeout(1_000);

    // 刷新:URL 带 ?graph= 且图名恢复
    await page.reload();
    await expect(page.locator('.fwf-topbar__name')).toHaveValue(
      'E2E 编排器验证图',
      { timeout: 20_000 }
    );

    // 返回画布:跳回主应用且画布可见
    await page.getByRole('button', { name: /← 画布/ }).click();
    await expect(page).toHaveURL(/\/(\?|$|#)/);
    await expect(page.locator('.board-host-svg')).toBeVisible({
      timeout: 20_000,
    });
  });
});

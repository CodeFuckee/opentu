/**
 * 项目抽屉测试（@functional）
 *
 * 覆盖：项目抽屉打开/关闭、标签（画布管理/PPT编辑/图层）、
 * 新建画板/新建目录/导入/导出入口。
 */
import { test, expect } from '../fixtures/test-base';

test.describe('项目抽屉', () => {
  test('打开/关闭项目抽屉', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    const projectBtn = page.getByTestId('toolbar-project');
    await expect(projectBtn).toBeVisible();
    await projectBtn.click();

    // 抽屉出现 + 标题
    const drawer = page.getByTestId('project-drawer');
    await expect(drawer).toBeVisible({ timeout: 8000 });
    await expect(
      page.getByRole('heading', { name: '项目', exact: true })
    ).toBeVisible();

    // 标签页
    const tabCanvas = drawer.getByRole('button', { name: '画布管理' });
    await expect(tabCanvas).toBeVisible();
    const tabPpt = drawer.getByRole('button', { name: 'PPT 编辑' });
    await expect(tabPpt).toBeVisible();
    const tabLayer = drawer.getByRole('button', { name: '图层' });
    await expect(tabLayer).toBeVisible();

    // 新建画板 / 新建目录 / 导入 / 导出
    await expect(
      drawer.getByRole('button', { name: '新建画板' })
    ).toBeVisible();
    await expect(
      drawer.getByRole('button', { name: '新建目录' })
    ).toBeVisible();
    await expect(drawer.getByRole('button', { name: '导入' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '导出' })).toBeVisible();

    // 关闭（再次点击项目按钮）
    await projectBtn.click();
    await expect(drawer).toBeHidden({ timeout: 8000 });
  });

  test('切换到 PPT 编辑标签', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId('toolbar-project').click();
    const drawer = page.getByTestId('project-drawer');
    await expect(drawer).toBeVisible({ timeout: 8000 });

    const pptTab = drawer.getByRole('button', { name: 'PPT 编辑' });
    await pptTab.click();
    await page.waitForTimeout(600);
    // PPT 标签激活（选中态类名）
    await expect(pptTab).toHaveClass(/active|selected/i);

    await page.keyboard.press('Escape');
  });
});
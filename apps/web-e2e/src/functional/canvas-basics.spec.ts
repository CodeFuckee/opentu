/**
 * 画布基础与工作区外壳测试（@functional）
 *
 * 覆盖：工作区加载、统一工具栏、工具选中态、更多工具菜单。
 * 所有测试以已登录状态启动（依赖 auth-setup 的 storageState）。
 */
import { test, expect } from '../fixtures/test-base';

/** 点击工具 radio 的直接父级 label（.tool-icon），触发受控 radio 切换 */
async function clickToolRadio(
  page: import('@playwright/test').Page,
  radio: import('@playwright/test').Locator
) {
  const label = radio.locator('xpath=..');
  await label.click({ force: true });
  await expect(radio).toBeChecked({ timeout: 5000 });
}

test.describe('画布基础', () => {
  test('工作区加载：画布、工具栏、AI 输入栏可见', async ({ page }) => {
    await page.goto('/');

    // 应用标题（品牌）
    await expect(page).toHaveTitle(/Yue画布/);

    // 核心容器
    const canvas = page.locator('.board-host-svg');
    await expect(canvas).toBeVisible({ timeout: 15000 });

    const toolbar = page.getByTestId('unified-toolbar');
    await expect(toolbar).toBeVisible();

    const aiInput = page.getByTestId('ai-input-textarea');
    await expect(aiInput).toBeVisible();

    const viewNavigation = page.getByTestId('view-navigation');
    await expect(viewNavigation).toBeVisible();
  });

  test('统一工具栏：核心工具按钮齐全', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    // 工具按钮（aria-label / data-track）
    const pencil = page.getByRole('button', { name: /画笔/ });
    await expect(pencil).toBeVisible();

    const shape = page.getByRole('button', { name: /形状/ });
    await expect(shape).toBeVisible();

    // 更多工具入口
    const more = page.getByTestId('toolbar-more');
    await expect(more).toBeVisible();

    // 底部操作区：项目 / 工具箱 / 任务队列
    await expect(page.getByTestId('toolbar-project')).toBeVisible();
    await expect(page.getByTestId('toolbar-toolbox')).toBeVisible();
    await expect(page.getByTestId('toolbar-tasks')).toBeVisible();

    // 已登录用户入口
    await expect(page.getByTestId('user-menu-button')).toBeVisible();
  });

  test('工具切换：选择/手形/文本 工具可切换选中态', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    const selectRadio = page.getByRole('radio', { name: /选择/ }).first();
    await expect(selectRadio).toBeVisible();
    await expect(selectRadio).toBeChecked();

    await clickToolRadio(
      page,
      page.getByRole('radio', { name: /手形工具/ }).first()
    );

    if ((await page.getByRole('radio', { name: /文本/ }).count()) > 0) {
      await clickToolRadio(
        page,
        page.getByRole('radio', { name: /文本/ }).first()
      );
    }
  });

  test('更多菜单：思维导图、箭头、Mermaid/Markdown 到 Drawnix、撤销重做', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId('toolbar-more').click();
    // 菜单项以 data-track 稳定定位
    const assertMenuTrack = async (track: string) => {
      await expect(
        page.locator(`[data-track="${track}"]`).first()
      ).toBeVisible({ timeout: 5000 });
    };

    await assertMenuTrack('toolbar_click_mind');
    await assertMenuTrack('toolbar_click_arrow');
    await assertMenuTrack('toolbar_click_markdown-to-drawnix');
    await assertMenuTrack('toolbar_click_mermaid-to-drawnix');
    await assertMenuTrack('toolbar_click_undo');
    await assertMenuTrack('toolbar_click_redo');

    // 关闭菜单
    await page.keyboard.press('Escape');
  });
});
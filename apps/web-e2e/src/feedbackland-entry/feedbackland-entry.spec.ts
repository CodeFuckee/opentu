import { expect, test } from '@playwright/test';

/**
 * Feedbackland 反馈入口 E2E
 *
 * 验证主应用（Yue画布）左侧边栏底部工具栏的 Feedbackland 反馈按钮：
 * 点击后在新标签页打开 Feedbackland 组织看板（FEEDBACKLAND_URL，
 * 当前为 http://10.37.80.25:8090/yjk），且看板页面正确显示；
 * 原画布不受影响。
 *
 * 前置条件：
 * - 主应用登录态：复用 auth-setup 保存的会话（项目依赖注入 storageState）
 * - 目标看板：http://10.37.80.25:8090/yjk（已部署，公开可读）
 *
 * 运行（--skip-nx-cache 确保真实执行）：
 *   pnpm e2e:feedbackland-entry
 *   pnpm e2e:feedbackland-entry:headed
 */

const FEEDBACK_BUTTON = '[data-testid="toolbar-feedbackland"]';

// 期望的看板地址（按钮跳转契约）。主应用环境可经 MAIN_APP_BASE_URL 切换；
// 生产 8088 上按钮仍是旧地址（8090 无 /yjk），用例会以 Expected/Received
// 形式暴露该未发布缺陷
const FEEDBACKLAND_BOARD_URL =
  process.env['FEEDBACKLAND_EXPECTED_URL'] || 'http://10.37.80.25:8090/yjk';
const FEEDBACKLAND_BOARD_ORIGIN = new URL(FEEDBACKLAND_BOARD_URL).origin;

test.describe('Feedbackland 反馈入口', () => {
  test('FL-001 点击反馈按钮，新标签页打开组织看板', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    const button = page.locator(FEEDBACK_BUTTON);
    await expect(
      button,
      '画布底部工具栏应渲染 Feedbackland 反馈按钮'
    ).toBeVisible({ timeout: 30_000 });

    const [feedbackPage] = await Promise.all([
      context.waitForEvent('page'),
      button.click(),
    ]);
    // 新标签页创建（about:blank）与真实导航之间存在竞态：先等待到达
    // 目标站点（origin 一致），再断言完整 URL（含 /yjk 路径）
    await feedbackPage.waitForURL(
      (url) => url.origin === FEEDBACKLAND_BOARD_ORIGIN,
      { timeout: 15_000 }
    );

    expect(
      feedbackPage.url(),
      '新标签页应打开 Feedbackland 组织看板地址'
    ).toBe(FEEDBACKLAND_BOARD_URL);

    // 看板核心元素
    await expect(
      feedbackPage.getByRole('heading', { name: 'Feedback board' }),
      '目标页应渲染看板标题'
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      feedbackPage.getByPlaceholder('Search...'),
      '目标页应渲染搜索框'
    ).toBeVisible();
    await expect(
      feedbackPage.getByRole('button', { name: 'Newest' }),
      '目标页应渲染排序筛选'
    ).toBeVisible();
    await expect(
      feedbackPage.getByRole('button', { name: 'Submit feedback' }),
      '目标页应渲染发帖输入区'
    ).toBeVisible();
  });

  test('FL-002 目标看板页无错误态', async ({ page, context }) => {
    await page.goto('/');
    const button = page.locator(FEEDBACK_BUTTON);
    await expect(button).toBeVisible({ timeout: 30_000 });

    const [feedbackPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      button.click(),
    ]);
    await feedbackPage.waitForLoadState('domcontentloaded');
    await expect(
      feedbackPage.getByRole('button', { name: 'Submit feedback' })
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      feedbackPage.getByText('Error loading posts'),
      '帖子列表不应出现加载失败提示'
    ).toHaveCount(0);
    await expect(
      feedbackPage.getByText('Internal Server Error', { exact: true }),
      '目标页不应出现服务端错误'
    ).toHaveCount(0);
  });

  test('FL-003 点击后主应用画布不受影响', async ({ page, context }) => {
    await page.goto('/');
    const button = page.locator(FEEDBACK_BUTTON);
    await expect(button).toBeVisible({ timeout: 30_000 });
    const urlBefore = page.url();

    const [feedbackPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      button.click(),
    ]);
    await feedbackPage.waitForLoadState('domcontentloaded');

    // 回到原标签页：画布未跳转、按钮仍在
    await page.bringToFront();
    expect(page.url(), '原画布不应发生跳转').toBe(urlBefore);
    await expect(
      page.locator(FEEDBACK_BUTTON),
      '原画布的反馈按钮应仍然存在'
    ).toBeVisible();
  });
});

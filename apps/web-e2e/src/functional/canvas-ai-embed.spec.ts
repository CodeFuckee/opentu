/**
 * 无限画布工作台嵌入 E2E（@functional）
 *
 * 嵌入形态：vendor 的 infinite-canvas(React 19) 独立构建在 /infinite/ 子路径；
 * 平台内入口 工具箱→AI 工具→「无限画布 ↗」开 /canvas-ai 宿主页(全屏 iframe)。
 * 覆盖：/infinite/ 直达(静态伺服,非主应用壳)、/canvas-ai 宿主页 iframe 承载
 * 与返回画布、工具箱入口全链路。
 * 以已登录状态启动（依赖 auth-setup 的 storageState）。
 */
import { test, expect } from '../fixtures/test-base';

/** 子应用画布壳稳定锚点:顶栏(与 locale 无关) */
const canvasHeader = (frame: ReturnType<ReturnType<typeof test>['expect']>) => frame;

test.describe('无限画布工作台嵌入', () => {
  test('E2E-CANVAS-AI-001 /infinite/ 直达:伺服子应用自身(非主应用壳)', async ({
    page,
  }) => {
    await page.goto('/infinite/');

    // 子应用顶栏渲染(hash 路由 SPA 挂载完成)
    await expect(page.locator('header').first()).toBeVisible({
      timeout: 20_000,
    });

    // 不是主应用壳:无主应用 AuthGate、无主画布
    await expect(page.getByTestId('auth-gate')).toHaveCount(0);
    await expect(page.locator('.board-host-svg')).toHaveCount(0);

    // hash 路由:根路径刷新(模拟用户在 #/config 深链刷新)后仍可用
    await page.goto('/infinite/#/config');
    await expect(page.locator('header').first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('E2E-CANVAS-AI-002 /canvas-ai 宿主页:iframe 承载 + 返回画布', async ({
    page,
  }) => {
    await page.goto('/canvas-ai');

    // 宿主页平台壳(主应用会话)下,iframe 加载子应用顶栏
    const frame = page.frameLocator('iframe[title="无限画布"]');
    await expect(frame.locator('header').first()).toBeVisible({
      timeout: 30_000,
    });

    // 返回主画布:整页跳回主应用且画布可见(崩溃恢复不误报)
    await page.getByTestId('canvas-ai-back').click();
    await expect(page).toHaveURL(/\/(\?|$|#)/);
    await expect(page.locator('.board-host-svg')).toBeVisible({
      timeout: 20_000,
    });
  });

  test('E2E-CANVAS-AI-003 工具箱「无限画布 ↗」入口全链路', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('toolbar-toolbox').click();
    const drawer = page.locator('.side-drawer--toolbar-right').first();
    await drawer.getByRole('button', { name: /AI 工具/ }).click();

    // 入口存在且点击后在新上下文打开 /canvas-ai
    const entry = drawer.getByTestId('toolbox-open-canvas-ai');
    await expect(entry).toBeVisible();
    const popupPromise = page.waitForEvent('popup');
    await entry.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/\/canvas-ai/);

    // 新窗口内子应用经宿主页 iframe 正常渲染
    const frame = popup.frameLocator('iframe[title="无限画布"]');
    await expect(frame.locator('header').first()).toBeVisible({
      timeout: 30_000,
    });
  });
});

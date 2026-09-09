import { expect, test, type Page } from '@playwright/test';

/**
 * 用户手册侧边栏导航 E2E
 *
 * 目标：手册（/user-manual/index.html）左侧边栏的每一项，点进去都必须是
 * "对应的"内容页——HTTP 200、页面标题与点击项一致、正文渲染出标题、
 * 且目标页侧边栏存在并高亮当前项。所有坏链接会在测试结束时一次性汇总报告。
 *
 * 同一份测试跑两个环境（见 playwright.config.ts projects）：
 * - manual-nav      开发环境：本地 dev server 托管 apps/web/public/user-manual
 * - manual-nav-prod 生产环境：http://10.37.80.25:8088（可用 MANUAL_PROD_BASE_URL 覆盖）
 *
 * 运行（--skip-nx-cache 确保真实执行、不回放缓存；注意用 nx run 的冒号语法，
 * `nx e2e web-e2e` 简写形式在部分 shell 下会把 --project 误解析为 nx 项目过滤参数）：
 *   pnpm e2e:manual-nav                # 开发环境
 *   pnpm e2e:manual-nav:prod           # 生产环境
 *   pnpm e2e:manual-nav:both           # 双环境一次跑完
 *   pnpm exec nx run web-e2e:e2e --skip-nx-cache -- --project=manual-nav --project=manual-nav-prod --headed
 * 或绕过 nx 直连 playwright（须在仓库根目录执行）：
 *   pnpm exec playwright test --config=apps/web-e2e/playwright.config.ts --project=manual-nav --project=manual-nav-prod --headed
 */

const MANUAL_INDEX_PATH = '/user-manual/index.html';
// 侧边栏导航项的下限（当前手册 24 项；设下限防止侧边栏整体渲染失败被误判为通过）
const MIN_SIDEBAR_ITEMS = 15;

interface SidebarLink {
  text: string;
  href: string;
}

async function collectSidebarLinks(page: Page): Promise<SidebarLink[]> {
  return page.locator('nav.sidebar .sidebar-nav a').evaluateAll((anchors) =>
    anchors
      .map((anchor) => ({
        text: (anchor.textContent || '').trim(),
        href: anchor.getAttribute('href') || '',
      }))
      .filter(
        (link) =>
          link.text.length > 0 &&
          link.href &&
          !/^https?:\/\//.test(link.href)
      )
  );
}

test.describe('用户手册侧边栏导航', () => {
  test('手册首页可访问且侧边栏渲染出导航项', async ({ page }) => {
    const response = await page.goto(MANUAL_INDEX_PATH);
    expect(response?.status(), `手册首页 ${MANUAL_INDEX_PATH} 应返回 200`).toBe(
      200
    );

    const links = await collectSidebarLinks(page);
    expect(
      links.length,
      `侧边栏应渲染出至少 ${MIN_SIDEBAR_ITEMS} 个导航项（含首页）`
    ).toBeGreaterThanOrEqual(MIN_SIDEBAR_ITEMS);

    // 侧边栏链接不应有重复目标（同一页面出现两次说明配置有误）
    const hrefs = links.map((link) => link.href);
    expect(new Set(hrefs).size, '侧边栏链接目标不应重复').toBe(hrefs.length);
  });

  // 逐项点击 20+ 个链接（dev 环境坏链接会加载到 SPA 回退页，整体较慢）
  test('逐项点击侧边栏，每项都进入对应的内容页', async ({ page }) => {
    test.setTimeout(240_000);

    const indexResponse = await page.goto(MANUAL_INDEX_PATH);
    expect(indexResponse?.status(), '手册首页应返回 200').toBe(200);

    const links = await collectSidebarLinks(page);
    expect(links.length, '侧边栏应渲染出导航项').toBeGreaterThanOrEqual(
      MIN_SIDEBAR_ITEMS
    );

    const brokenLinks: string[] = [];

    for (const link of links) {
      // 每次都从首页出发点击，贴近用户真实路径
      await page.goto(MANUAL_INDEX_PATH);

      const target = page.locator(
        `nav.sidebar .sidebar-nav a[href="${link.href}"]`
      );
      await expect(
        target,
        `侧边栏应存在「${link.text}」(${link.href})`
      ).toHaveCount(1);

      const alreadyOnTarget = page.url().endsWith(`/${link.href}`);
      let status = 200;
      let actualTitle = await page.title();
      if (!alreadyOnTarget) {
        const navResponsePromise = page.waitForResponse(
          (response) => response.request().resourceType() === 'document'
        );
        await target.click();
        status = (await navResponsePromise).status();
        // 标题在文档加载完成即确定（静态页），无需等待任何异步渲染
        await page.waitForLoadState('domcontentloaded');
        actualTitle = await page.title();
      }

      // 1) 文档响应必须 200
      if (status !== 200) {
        brokenLinks.push(`「${link.text}」(${link.href}) → HTTP ${status}`);
        continue;
      }

      // 2) 页面标题必须与点击项对应。生成规则是 `{页面标题} | {站点标题}`，
      //    用严格前缀匹配：应用壳（SPA 回退页）标题里可能恰好包含某些
      //    侧边栏关键词（如"流程图/思维导图"），子串匹配会误判通过。
      //    index 页标题是"Yue画布 用户手册首页 | ..."，不含"首页 |"前缀，单独豁免。
      const isIndexLink = link.href === 'index.html';
      if (!isIndexLink) {
        const titlePrefix = `${link.text} | `;
        if (!actualTitle.startsWith(titlePrefix)) {
          brokenLinks.push(
            `「${link.text}」(${link.href}) → 标题不匹配（实际「${actualTitle}」）`
          );
          continue;
        }
      }

      // 3) 正文渲染出内容标题（而不是空白/错误页）；count() 非等待式，
      //    避免 SPA 回退页上元素不存在导致自动等待拖满超时
      const heading = page.locator('.main-content article h1').first();
      const headingText =
        (await heading.count()) > 0
          ? ((await heading.textContent()) || '').trim()
          : '';
      if (headingText.length === 0) {
        brokenLinks.push(`「${link.text}」(${link.href}) → 正文缺少 h1 标题`);
        continue;
      }

      // 4) 目标页同样是完整手册页：侧边栏存在且当前项高亮
      const activeLinkCount = await page
        .locator(`nav.sidebar .sidebar-nav a.active[href="${link.href}"]`)
        .count();
      if (activeLinkCount !== 1) {
        brokenLinks.push(
          `「${link.text}」(${link.href}) → 侧边栏未高亮当前项（active 链接数 ${activeLinkCount}）`
        );
        continue;
      }
    }

    expect(
      brokenLinks,
      `共有 ${brokenLinks.length} 个侧边栏项无法打开对应页面：\n  ${brokenLinks.join('\n  ')}`
    ).toEqual([]);
  });
});

import { expect, test, type Page, type Request, type Response } from '@playwright/test';

/**
 * 用户手册全页面图片加载 E2E
 *
 * 目标：手册（/user-manual/index.html）每一个内容页（以侧边栏导航项为准，含首页）
 * 上渲染的所有 <img> 图片都必须正常加载。每张图校验三层：
 *   1. 网络层：响应 200 且 content-type 为图片类型（防止 dev server 把缺失图片
 *      回退成 SPA 的 index.html——状态码是 200 但图片实际是 HTML，只查状态码会漏判）；
 *   2. 解码层：naturalWidth > 0（捕获 404、请求失败、返回内容不是真图片）；
 *   3. 渲染层：实际布局尺寸 > 0（捕获"解码成功但 CSS 上不可见"）。
 *
 * 注意：手册图片大量使用 loading="lazy"（当前 39 个 <img> 中 31 个），必须逐张
 * scrollIntoView 触发真实加载，不能只看初始视口。
 *
 * 同一份测试跑两个环境（见 playwright.config.ts projects）：
 * - manual-nav      开发环境：本地 dev server 托管 apps/web/public/user-manual
 * - manual-nav-prod 生产环境：http://10.37.80.25:8088（可用 MANUAL_PROD_BASE_URL 覆盖）。
 *   生产构建会把截图指向 CDN（MANUAL_CDN_BASE），两环境的图片 URL 集合可能不同，
 *   本测试只审计"各环境页面实际引用的图片"，不假设两环境一致。
 *
 * 前置条件（幂等，可重复执行）：目标环境的手册产物与截图已生成——
 *   pnpm manual:update   # = manual:screenshots + manual:build
 *   （生产环境由部署流水线产出，无需本地准备）
 *
 * 运行（--skip-nx-cache 确保真实执行；用 nx run 的冒号语法，见 manual-nav.spec.ts 说明）：
 *   pnpm e2e:manual-nav                # 开发环境
 *   pnpm e2e:manual-nav:prod           # 生产环境
 *   pnpm e2e:manual-nav:both           # 双环境一次跑完
 *   pnpm exec playwright test --config=apps/web-e2e/playwright.config.ts --project=manual-nav --project=manual-nav-prod --headed
 */

const MANUAL_INDEX_PATH = '/user-manual/index.html';
// 手册目录（侧边栏 href 相对该目录解析）。注意 Playwright 的 page.goto 相对 URL
// 是基于 baseURL（站点根）而非当前页面 URL 解析，必须手动拼出手册目录下的绝对路径
const MANUAL_DIR = MANUAL_INDEX_PATH.replace(/[^/]*$/, '');
// 侧边栏导航项的下限（当前 24 项；设下限防止侧边栏整体渲染失败被误判为通过）
const MIN_SIDEBAR_ITEMS = 15;
// 首页图片数下限（当前 5 张；首页演示图是站点门面，跨版本稳定存在；
// 防止首页图片整体缺失/页面空壳时"0 张图全通过"的假阳性）
const MIN_INDEX_IMAGES = 3;
// 单张图片等待加载落定的上限：lazy 触发 + 网络加载 + 解码；坏图会更快置位 complete
const IMAGE_SETTLE_TIMEOUT_MS = 10_000;

interface SidebarLink {
  text: string;
  href: string;
}

/** 单条图片问题：哪个页面、哪张图、什么原因 */
interface ImageIssue {
  page: string;
  src: string;
  reason: string;
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

/** 宽松比较 URL（浏览器对中文等字符的百分号编码两侧一致，但为稳妥做 decode 兜底） */
function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return decodeURIComponent(a) === decodeURIComponent(b);
  } catch {
    return false;
  }
}

/**
 * 进入页面（调用方已完成文档级校验）后审计当前页所有 <img>。
 * 返回问题列表与审计图片总数；问题为空即本页全部图片正常。
 */
async function auditPageImages(
  page: Page,
  pageLabel: string
): Promise<{ issues: ImageIssue[]; audited: number }> {
  const issues: ImageIssue[] = [];
  const reported = new Set<string>();

  const pushIssue = (src: string, reason: string) => {
    const key = `${src}|${reason}`;
    if (reported.has(key)) return;
    reported.add(key);
    issues.push({ page: pageLabel, src, reason });
  };

  // 监听全部网络响应（按 URL 记录，重定向以最后一跳为准）与彻底失败的请求，
  // 用于在解码失败时给出比"解码失败"更准确的归因。注意不能按 resourceType === 'image'
  // 过滤：图片 URL 被 SPA 回退成 HTML 时 Chromium 对其分类不稳定，会导致归因漂移
  const imageResponses = new Map<string, { status: number; contentType: string }>();
  const failedRequests = new Set<string>();
  const onResponse = (response: Response) => {
    imageResponses.set(response.url(), {
      status: response.status(),
      contentType: response.headers()['content-type'] || '',
    });
  };
  const onRequestFailed = (request: Request) => {
    failedRequests.add(request.url());
  };
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  const lookupNetwork = (src: string) => {
    for (const [url, info] of imageResponses) {
      if (sameUrl(url, src)) return info;
    }
    return undefined;
  };
  const hasFailedRequest = (src: string) => {
    for (const url of failedRequests) {
      if (sameUrl(url, src)) return true;
    }
    return false;
  };

  try {
    const imgs = page.locator('img');
    const total = await imgs.count();

    for (let i = 0; i < total; i++) {
      const img = imgs.nth(i);
      const meta = await img.evaluate((el) => ({
        src: (el as HTMLImageElement).src,
      }));

      if (!meta.src) {
        pushIssue('(空 src)', 'img 元素缺少 src 属性');
        continue;
      }

      // 滚动进入视口触发 loading="lazy" 图片的真实加载（data: URL 无网络请求，跳过）
      if (!meta.src.startsWith('data:')) {
        await img.scrollIntoViewIfNeeded();
      }

      // 等待加载落定：成功与失败都会把 complete 置位，因此坏图不会拖满超时。
      // 注意 evaluate 回调运行在浏览器上下文，模块常量须以参数传入
      await img.evaluate(
        (el, timeoutMs) =>
          new Promise<void>((resolve) => {
            const image = el as HTMLImageElement;
            if (image.complete) {
              resolve();
              return;
            }
            const deadline = Date.now() + timeoutMs;
            const timer = setInterval(() => {
              if (image.complete || Date.now() > deadline) {
                clearInterval(timer);
                resolve();
              }
            }, 100);
          }),
        IMAGE_SETTLE_TIMEOUT_MS
      );

      const state = await img.evaluate((el) => ({
        naturalWidth: (el as HTMLImageElement).naturalWidth,
      }));

      if (state.naturalWidth === 0) {
        // 归因顺序：网络失败 → 非 200 → 200 但内容不是图片（SPA 回退）→ 其它解码失败
        if (hasFailedRequest(meta.src)) {
          pushIssue(meta.src, '网络请求失败（requestfailed，无响应）');
          continue;
        }
        const net = lookupNetwork(meta.src);
        if (net && net.status !== 200) {
          pushIssue(meta.src, `HTTP ${net.status}`);
          continue;
        }
        if (net && /text\/html/i.test(net.contentType)) {
          pushIssue(
            meta.src,
            `HTTP ${net.status} 但返回 HTML（SPA 回退顶替图片，多为截图文件缺失）`
          );
          continue;
        }
        if (net && !net.contentType.startsWith('image/')) {
          pushIssue(meta.src, `content-type 非图片（${net.contentType}）`);
          continue;
        }
        pushIssue(
          meta.src,
          '图片解码失败（naturalWidth=0，本次未见网络响应、图片可能来自缓存；结合其它页面的同一图片表现，多为文件缺失/内容非图片）'
        );
        continue;
      }

      const box = await img.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) {
        pushIssue(meta.src, `图片解码成功但渲染尺寸为 0（${box ? `${box.width}x${box.height}` : '无布局盒'})`);
      }
    }

    return { issues, audited: total };
  } finally {
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
}

function formatIssues(issues: ImageIssue[]): string {
  return issues
    .map((issue) => `[${issue.page}] ${issue.src} → ${issue.reason}`)
    .join('\n  ');
}

/** 从静态 HTML 声明中统计 <img> 标签数（运行时审计数应 ≥ 该值，保证审计覆盖完整） */
function countDeclaredImages(html: string): number {
  return (html.match(/<img\b/gi) || []).length;
}

test.describe('用户手册页面图片加载', () => {
  // E2E-IMG-001
  test('手册首页所有图片加载成功', async ({ page }) => {
    const response = await page.goto(MANUAL_INDEX_PATH);
    expect(response?.status(), `手册首页 ${MANUAL_INDEX_PATH} 应返回 200`).toBe(
      200
    );
    const declared = countDeclaredImages((await response?.text()) ?? '');

    // 首页结构健全性：侧边栏正常渲染（复用 nav spec 的下限规则），防止审计的是空壳页
    const links = await collectSidebarLinks(page);
    expect(
      links.length,
      `侧边栏应渲染出至少 ${MIN_SIDEBAR_ITEMS} 个导航项`
    ).toBeGreaterThanOrEqual(MIN_SIDEBAR_ITEMS);

    const { issues, audited } = await auditPageImages(page, 'index.html');
    expect(
      audited,
      `首页应至少渲染 ${MIN_INDEX_IMAGES} 张图片（当前 5 张），0 张说明页面空壳`
    ).toBeGreaterThanOrEqual(MIN_INDEX_IMAGES);
    expect(
      audited,
      `首页静态声明 ${declared} 张图片，运行时仅审计到 ${audited} 张（审计不完整）`
    ).toBeGreaterThanOrEqual(declared);

    expect(
      issues,
      `首页存在 ${issues.length} 张无法正常加载的图片：\n  ${formatIssues(issues)}`
    ).toEqual([]);
  });

  // E2E-IMG-002
  test('侧边栏全部内容页所有图片加载成功', async ({ page }) => {
    test.setTimeout(300_000);

    const indexResponse = await page.goto(MANUAL_INDEX_PATH);
    expect(indexResponse?.status(), '手册首页应返回 200').toBe(200);

    const links = await collectSidebarLinks(page);
    expect(links.length, '侧边栏应渲染出导航项').toBeGreaterThanOrEqual(
      MIN_SIDEBAR_ITEMS
    );

    const allIssues: ImageIssue[] = [];
    let totalAudited = 0;

    for (const link of links) {
      // 每次从首页出发进入目标页，贴近用户真实路径；goto 相对 href 基于当前 index URL 解析
      await page.goto(MANUAL_INDEX_PATH);
      const docResponse = await page.goto(`${MANUAL_DIR}${link.href}`);
      const pageLabel = `「${link.text}」(${link.href})`;

      // 页面本身必须真实可达（复用 nav spec 的规则）：200 + 标题前缀 + 正文 h1。
      // dev 环境坏链接会 200 返回 SPA 回退页，仅凭状态码会误判。
      if ((docResponse?.status() ?? 0) !== 200) {
        allIssues.push({
          page: pageLabel,
          src: '(页面本身)',
          reason: `文档 HTTP ${docResponse?.status()}`,
        });
        continue;
      }
      const isIndexLink = link.href === 'index.html';
      const actualTitle = await page.title();
      if (!isIndexLink && !actualTitle.startsWith(`${link.text} | `)) {
        allIssues.push({
          page: pageLabel,
          src: '(页面本身)',
          reason: `标题不匹配（实际「${actualTitle}」，疑似 SPA 回退页）`,
        });
        continue;
      }
      const heading = page.locator('.main-content article h1').first();
      const headingText =
        (await heading.count()) > 0
          ? ((await heading.textContent()) || '').trim()
          : '';
      if (headingText.length === 0) {
        allIssues.push({
          page: pageLabel,
          src: '(页面本身)',
          reason: '正文缺少 h1 标题（疑似 SPA 回退页）',
        });
        continue;
      }

      // 审计完整性（版本无关的不变量）：运行时审计到的图片数不得少于该页静态
      // HTML 声明的 <img> 数，保证"所有图片"确实都被覆盖（替代跨环境全局总数
      // 下限——各环境部署的手册版本不同、图片总数本就不同，不能互相假设）
      const declared = countDeclaredImages((await docResponse?.text()) ?? '');

      const { issues, audited } = await auditPageImages(page, pageLabel);
      totalAudited += audited;
      allIssues.push(...issues);
      if (audited < declared) {
        allIssues.push({
          page: pageLabel,
          src: '(审计完整性)',
          reason: `页面静态声明 ${declared} 张图片，运行时仅审计到 ${audited} 张`,
        });
      }
    }

    expect(
      totalAudited,
      '整轮未审计到任何图片，手册整体异常（空壳/回退页）'
    ).toBeGreaterThan(0);

    expect(
      allIssues,
      `共有 ${allIssues.length} 个图片/页面问题：\n  ${formatIssues(allIssues)}`
    ).toEqual([]);
  });
});

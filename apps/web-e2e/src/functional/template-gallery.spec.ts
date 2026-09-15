/**
 * 模板中心测试（@functional）
 *
 * 覆盖：入口打开、分类/排序/搜索、详情与提示词、复制提示词（仅 Chromium）、
 * 「去创作」填充输入框与使用计数、未登录降级提示、AI 输入条回归。
 *
 * 数据：使用 source='e2e' 的专用种子模板（【E2E】前缀），beforeAll 播种 /
 * afterAll 清理，不污染真实爬取数据。请以 --workers=1 运行本文件
 * （种子清理依赖单 worker 顺序执行）。
 */
import { test, expect } from '../fixtures/test-base';
import type { Page } from '@playwright/test';
import {
  cleanupE2eTemplates,
  getSeedUsageCount,
  seedE2eTemplates,
  TEMPLATE_A,
  TEMPLATE_B,
} from '../utils/template-seed';

const galleryButton = (page: Page) =>
  page.locator('[data-track="ai_input_click_template_gallery"]');
const overlay = (page: Page) =>
  page.getByTestId('template-gallery-overlay');
const cards = (page: Page) =>
  page.locator('[data-testid="template-gallery-card"]');
const cardByTitle = (page: Page, title: string) =>
  cards(page).filter({ hasText: title });
const aiTextarea = (page: Page) => page.getByTestId('ai-input-textarea');

async function openGallery(page: Page): Promise<void> {
  await expect(aiTextarea(page)).toBeVisible({ timeout: 15000 });
  await galleryButton(page).click();
  await expect(overlay(page)).toBeVisible({ timeout: 8000 });
}

test.describe('模板中心', () => {
  test.describe.configure({ mode: 'serial' });
  let seedFailed = false;

  test.beforeAll(async () => {
    try {
      await cleanupE2eTemplates();
      await seedE2eTemplates();
    } catch (error) {
      seedFailed = true;
      console.error('[template-gallery] 种子数据准备失败:', error);
    }
  });

  test.afterAll(async () => {
    if (!seedFailed) {
      await cleanupE2eTemplates();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(seedFailed, '种子数据准备失败（缺 service key 或数据库不可达）');
    await page.goto('/');
    await openGallery(page);
    // 等种子卡片渲染（列表查询完成）
    await expect(cardByTitle(page, TEMPLATE_A.title).first()).toBeVisible({
      timeout: 10000,
    });
  });

  test('E2E-001 打开模板中心显示种子模板', async ({ page }) => {
    await expect(overlay(page)).toBeVisible();
    await expect(
      page.locator('.template-gallery__categories button').first()
    ).toBeVisible();
    await expect(cardByTitle(page, TEMPLATE_A.title)).toHaveCount(1);
    await expect(cardByTitle(page, TEMPLATE_B.title)).toHaveCount(1);
  });

  test('E2E-002 热度排序：高使用数种子模板排首位', async ({ page }) => {
    await expect(
      page
        .locator('[data-testid="template-gallery-card"]')
        .first()
        .locator('.template-gallery__card-title')
    ).toHaveText(TEMPLATE_A.title);
  });

  test('E2E-003 切换最新排序', async ({ page }) => {
    await page
      .locator('.template-gallery__sort button', { hasText: '最新' })
      .click();
    // 种子行 crawled_at 为播种时刻（晚于真实爬取行），B 后播种故排首位
    await expect(
      page
        .locator('[data-testid="template-gallery-card"]')
        .first()
        .locator('.template-gallery__card-title')
    ).toHaveText(TEMPLATE_B.title);
  });

  test('E2E-004 分类过滤', async ({ page }) => {
    await page
      .locator('.template-gallery__categories button', { hasText: '效果渲染' })
      .click();
    await expect(cardByTitle(page, TEMPLATE_A.title)).toHaveCount(1);
    await expect(cardByTitle(page, TEMPLATE_B.title)).toHaveCount(0);
  });

  test('E2E-005 标题搜索', async ({ page }) => {
    await page
      .locator('.template-gallery__search input')
      .fill('【E2E】');
    await page
      .locator('.template-gallery__search input')
      .press('Enter');
    await expect(cards(page)).toHaveCount(2, { timeout: 8000 });
    await expect(cardByTitle(page, TEMPLATE_A.title)).toHaveCount(1);
    await expect(cardByTitle(page, TEMPLATE_B.title)).toHaveCount(1);
  });

  test('E2E-006 详情展示完整提示词', async ({ page }) => {
    await cardByTitle(page, TEMPLATE_A.title).click();
    const detail = page.locator('.template-gallery__detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.template-gallery__detail-title')).toHaveText(
      TEMPLATE_A.title
    );
    await expect(
      detail.locator('.template-gallery__detail-prompt')
    ).toContainText('E2E 种子提示词 A');
    const catalogs = detail.locator('.template-gallery__detail-catalogs');
    await expect(catalogs).toContainText('效果渲染');
    await expect(catalogs).toContainText('景观渲染');
    // 原图/参考图缩略图（种子 A 携带 1 张）
    await expect(
      detail.locator('.template-gallery__detail-base-images img')
    ).toHaveCount(1);
  });

  test('E2E-008 去创作：填充输入框并计数+1', async ({ page }) => {
    const before = await getSeedUsageCount(TEMPLATE_A.source_id);

    await cardByTitle(page, TEMPLATE_A.title).click();
    const detail = page.locator('.template-gallery__detail');
    await expect(detail).toBeVisible();
    await page.getByTestId('template-gallery-use').click();

    // 抽屉关闭，提示词填入 AI 输入框
    await expect(overlay(page)).toBeHidden({ timeout: 8000 });
    await expect(aiTextarea(page)).toHaveValue(TEMPLATE_A.prompt);

    // 重新打开：卡片使用计数 +1
    await galleryButton(page).click();
    await expect(overlay(page)).toBeVisible();
    await expect(cardByTitle(page, TEMPLATE_A.title)).toBeVisible();
    await expect(cardByTitle(page, TEMPLATE_A.title)).toContainText(
      `↗ ${before + 1}`
    );
  });

  test('E2E-012 带参考图模板去创作后参考图进入输入框', async ({ page }) => {
    // 初始无参考图预览
    await expect(
      page.locator('.ai-input-bar__content-preview img')
    ).toHaveCount(0);

    await cardByTitle(page, TEMPLATE_A.title).click();
    const detail = page.locator('.template-gallery__detail');
    await expect(detail).toBeVisible();
    // 详情内展示原图/参考图缩略图
    await expect(
      detail.locator('.template-gallery__detail-base-images img')
    ).toHaveCount(1);
    await page.getByTestId('template-gallery-use').click();

    // 抽屉关闭、提示词填充，且参考图作为输入框附件出现
    await expect(overlay(page)).toBeHidden({ timeout: 8000 });
    await expect(aiTextarea(page)).toHaveValue(TEMPLATE_A.prompt);
    // 预览组件对每张参考图渲染多个 img 元素，断言至少一张可见的参考图缩略图
    const previewImg = page.locator('.ai-input-bar__content-preview img').first();
    await expect(previewImg).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const imgs = [
            ...document.querySelectorAll('.ai-input-bar__content-preview img'),
          ];
          return imgs.filter(
            (img) =>
              !!img.getAttribute('src') &&
              img.complete &&
              img.naturalWidth > 0
          ).length;
        })
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('E2E-013 无参考图模板去创作不产生预览图', async ({ page }) => {
    await cardByTitle(page, TEMPLATE_B.title).click();
    const detail = page.locator('.template-gallery__detail');
    await expect(detail).toBeVisible();
    await expect(
      detail.locator('.template-gallery__detail-base-images')
    ).toHaveCount(0);
    await page.getByTestId('template-gallery-use').click();

    await expect(overlay(page)).toBeHidden({ timeout: 8000 });
    await expect(aiTextarea(page)).toHaveValue(TEMPLATE_B.prompt);
    await expect(
      page.locator('.ai-input-bar__content-preview img')
    ).toHaveCount(0, { timeout: 8000 });
  });

  test('E2E-010 回归：AI 输入条原功能不受影响', async ({ page }) => {
    await page.locator('.template-gallery__close').click();
    await expect(overlay(page)).toBeHidden({ timeout: 8000 });
    await aiTextarea(page).fill('回归测试提示词');
    await expect(aiTextarea(page)).toHaveValue('回归测试提示词');
    await expect(
      page.locator('[data-track="ai_input_click_upload"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-track="ai_input_click_library"]')
    ).toBeVisible();
  });

  test('E2E-011 模板封面图片全部正常加载', async ({ page }) => {
    // 记录封面请求中失败的状态码（≥400）
    const badResponses: string[] = [];
    page.on('response', (response) => {
      if (
        response.url().includes('/storage/v1/object/public/images/templates/') &&
        response.status() >= 400
      ) {
        badResponses.push(`${response.status()} ${response.url().slice(0, 120)}`);
      }
    });

    // 懒加载：分步滚动抽屉体触发所有卡片图片开始加载
    await page.evaluate(() => {
      const body = document.querySelector('.template-gallery__body');
      if (body) body.scrollTop = 0;
    });
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => {
        const body = document.querySelector('.template-gallery__body');
        if (body) body.scrollBy(0, Math.round(body.clientHeight * 0.8));
      });
      await page.waitForTimeout(250);
    }

    // 断言一：有封面的卡片数 = 卡片总数 - 2（两条种子行无封面，渲染占位符）
    const cardCount = await cards(page).count();
    expect(cardCount).toBeGreaterThanOrEqual(30);
    const imgs = cards(page).locator('img');
    await expect(imgs).toHaveCount(cardCount - 2, { timeout: 15000 });

    // 断言二：全部图片加载完成且真实解码成功（naturalWidth > 0，坏图/断链为 0）
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              [
                ...document.querySelectorAll(
                  '[data-testid="template-gallery-card"] img'
                ),
              ].filter((img) => img.complete && img.naturalWidth > 0).length
          ),
        { timeout: 20000, intervals: [500, 1000, 2000] }
      )
      .toBe(cardCount - 2);

    // 断言三：无失败的封面响应
    expect(badResponses).toEqual([]);
  });

  function assertClipboard(actual: string, expected: string): void {
    expect(actual).toBe(expected);
  }
});


test.describe('模板中心（复制提示词，Chromium）', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  let seedFailed = false;

  test.beforeAll(async () => {
    try {
      await cleanupE2eTemplates();
      await seedE2eTemplates();
    } catch (error) {
      seedFailed = true;
      console.error('[template-gallery] 种子数据准备失败:', error);
    }
  });

  test.beforeEach(async () => {
    test.skip(seedFailed, '种子数据准备失败（缺 service key 或数据库不可达）');
  });

  test.afterAll(async () => {
    await cleanupE2eTemplates();
  });

  test('E2E-007 复制提示词', async ({ page }) => {
    const browserName = page.context().browser()?.browserType().name() ?? 'unknown';
    test.skip(browserName !== 'chromium', `剪贴板权限仅 Chromium 授予（当前: ${browserName}）`);
    await page.goto('/');
    await expect(aiTextarea(page)).toBeVisible({ timeout: 15000 });
    await galleryButton(page).click();
    await expect(cardByTitle(page, TEMPLATE_A.title).first()).toBeVisible({ timeout: 10000 });
    await cardByTitle(page, TEMPLATE_A.title).click();
    const detail = page.locator('.template-gallery__detail');
    await expect(detail).toBeVisible();
    await detail.locator('.template-gallery__detail-copy').click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(TEMPLATE_A.prompt);
  });
});

test.describe('模板中心（未登录）', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('E2E-009 未登录被登录门禁拦截，模板入口不可达', async ({ page }) => {
    await page.goto('/');
    // 未登录：应用整体停在登录门禁（登录 Yue画布），画布与 AI 输入条不可达，
    // 模板中心入口随之不可达（模板中心仅在登录态注册）
    await expect(page.getByRole('heading', { name: '登录 Yue画布' })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.locator('[data-track="ai_input_click_template_gallery"]')
    ).toHaveCount(0);
    await expect(page.getByTestId('template-gallery-overlay')).toHaveCount(0);
  });
});

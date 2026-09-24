/**
 * AI 生图 → 画布结果图 URL 验证（方案 1：等待归档完成后插入、直接使用 bucket URL）
 *
 * 真实提交一次生图任务（消耗一次生成额度，已由用户确认），验证：
 * - 生成完成后结果图自动插入画布；
 * - 画布结果图的加载 URL 是 ai-outputs 公开桶直链
 *   （/object/public/ai-outputs/），而非第三方供应商地址。
 *
 * 失败诊断：用例收集等待期间全部图片加载请求 URL、画布内图片元素 URL
 * 与任务侧栏文本，失败时随断言消息输出。
 * 前置：测试账号有可用的图片模型额度（无额度时生成阶段失败，原因见任务侧栏）。
 */
import { test, expect } from '../fixtures/test-base';

const AI_OUTPUTS_PATTERN = '/object/public/ai-outputs/';
/** 生成+归档等待上限：实测生成 1~2 分钟、完成后归档再 ~50s，取 7 分钟 */
const GENERATE_WAIT_MS = 420_000;

test.describe('AI 生图画布 URL', () => {
  test('E2E-AI-001 生图完成 → 画布结果图加载 ai-outputs 公开桶直链', async ({
    page,
  }) => {
    test.setTimeout(480_000);

    // 预置：自动插入画布开启（走 localStorage，避免依赖勾选框 UI 状态）
    await page.addInitScript(() => {
      localStorage.setItem('aitu_image_auto_insert_canvas', 'true');
    });

    // 收集等待期间全部图片类加载请求 URL + 关键控制台日志（诊断用）
    const imageRequestUrls: string[] = [];
    const diagLogs: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (
        /\.(png|jpe?g|webp)(\?|$)/i.test(url) ||
        url.includes('/object/public/ai-outputs/')
      ) {
        imageRequestUrls.push(url);
      }
    });
    page.on('console', (msg) => {
      const text = msg.text();
      if (
        text.includes('[TaskArchive]') ||
        text.includes('[AutoInsert]') ||
        text.includes('[CanvasInsertion]')
      ) {
        diagLogs.push(text.slice(0, 300));
      }
    });

    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    // 打开 AI 生图对话框
    await page.locator('[data-track="toolbar_click_ai-image"]').click();
    const dialog = page.locator('.ai-image-generation-container');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // 填提示词并点生成（纯图像描述，避免模型把用例标记词误解为其他指令）
    await dialog
      .locator('textarea')
      .first()
      .fill('一只戴蓝色围巾的橘猫特写，白色背景，扁平插画风格');
    await dialog.locator('[data-track="ai_click_generate"]').click();

    // 生成时长不确定（实测 1~2 分钟），轮询等待公开桶图片加载 URL 出现
    const supabaseUrls = () =>
      imageRequestUrls.filter((u) => u.includes(AI_OUTPUTS_PATTERN));
    const deadline = Date.now() + GENERATE_WAIT_MS;
    while (Date.now() < deadline && supabaseUrls().length === 0) {
      await page.waitForTimeout(2000);
    }

    // 诊断数据：画布内图片元素 URL + 任务侧栏文本 + 关键控制台日志 + 画布 DOM 样本
    const boardImageUrls = await page.evaluate(() => {
      const urls: string[] = [];
      document
        .querySelectorAll(
          '.board-host-svg img, .board-host-svg image, img, image'
        )
        .forEach((el) => {
          const u =
            el.getAttribute('src') ||
            el.getAttribute('href') ||
            el.getAttribute('xlink:href') ||
            '';
          if (u && (u.startsWith('http') || u.startsWith('/'))) {
            urls.push(u);
          }
        });
      return urls;
    });
    const boardHostCount = await page.evaluate(
      () => document.querySelectorAll('.board-host-svg').length
    );
    const boardHtmlSample = await page.evaluate(() => {
      const host = document.querySelector('.board-host-svg');
      return host ? host.innerHTML.slice(0, 1500) : '(无 .board-host-svg)';
    });
    const taskSidebar = page.locator('.task-sidebar');
    const taskText =
      (await taskSidebar.count()) > 0
        ? await taskSidebar.innerText()
        : '(任务侧栏不可见)';

    const diag = [
      `收集到的图片加载请求（去重 ${new Set(imageRequestUrls).size} 个）：`,
      ...[...new Set(imageRequestUrls)].map((u) => `  ${u}`),
      '',
      `画布/页面内图片元素 URL（${boardImageUrls.length} 个）：`,
      ...boardImageUrls.map((u) => `  ${u}`),
      '',
      `board-host-svg 数量: ${boardHostCount}`,
      `画布 DOM 样本: ${boardHtmlSample.slice(0, 800)}`,
      '',
      `关键控制台日志（${diagLogs.length} 条）：`,
      ...diagLogs.map((l) => `  ${l}`),
      '',
      `任务侧栏文本：${taskText.replace(/\n+/g, ' | ').slice(0, 500)}`,
    ].join('\n');

    expect(
      supabaseUrls().length,
      `等待期内未出现 ai-outputs 公开桶图片加载 URL。\n${diag}`
    ).toBeGreaterThan(0);

    // 画布上的图片元素应使用公开桶直链
    expect(
      boardImageUrls.some((u) => u.includes(AI_OUTPUTS_PATTERN)),
      `画布图片元素未使用 ai-outputs 直链。\n${diag}`
    ).toBe(true);
  });
});

/**
 * UI 改动前后对比截图工具（独立于 IAB，用项目自带 Playwright）
 * 用法: node scripts/ui-audit-shots.mjs <baseUrl> <outDir>
 * 依赖 apps/web-e2e 已安装的 @playwright/test（复用其浏览器二进制）
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:7300';
const outDir = process.argv[3] || '/tmp/ui-after-opentu';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launchPersistentContext('/tmp/opentu-ui-profile', {
  viewport: { width: 1440, height: 900 },
});
const page = browser.pages()[0] ?? (await browser.newPage());
page.setDefaultTimeout(30000);

await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

// 等应用就绪：登录表单或主工具栏二者其一（冷启动 SW 预热可能超过 30s）
const loginBox = page.getByRole('textbox', { name: 'oa账号（小写）' });
const toolbar = page.getByTestId('toolbar-toolbox');
await Promise.race([
  loginBox.waitFor({ state: 'visible', timeout: 120000 }),
  toolbar.waitFor({ state: 'visible', timeout: 120000 }),
]);

if (await loginBox.count()) {
  await loginBox.fill('e2e_sync_a');
  await page
    .getByRole('textbox', { name: '密码（至少 6 位）' })
    .fill('E2eTest_2026!');
  await page.getByRole('button', { name: '登录' }).click({ force: true });
  // 登录后可能出现崩溃恢复弹窗 → 进安全模式
  const safe = page.getByRole('button', { name: '安全模式' });
  if (await safe.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null)) {
    await safe.click();
  }
}

await toolbar.waitFor({ state: 'visible', timeout: 90000 });
await page.waitForTimeout(3000); // 等画布与灵感板渲染稳定
await page.screenshot({ path: `${outDir}/01_main_default.png` });

// 工具箱
await toolbar.click({ force: true });
await page.waitForTimeout(1800);
await page.screenshot({ path: `${outDir}/02_toolbox_open.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(800);

// 项目抽屉
await page.getByTestId('toolbar-project').click({ force: true });
await page.waitForTimeout(1800);
await page.screenshot({ path: `${outDir}/03_project_open.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(800);

// 更多菜单
await page.getByTestId('toolbar-more').click({ force: true });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outDir}/04_more_menu.png` });
await page.keyboard.press('Escape');

await browser.close();
console.log('saved to', outDir);

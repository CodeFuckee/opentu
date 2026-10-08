import { test, expect } from '../fixtures/test-base';
import { writeFileSync } from 'node:fs';
test('probe move in edit mode', async ({ page }) => {
  test.setTimeout(180_000);
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 150)); });
  page.on('pageerror', (e) => errs.push('PAGEERR ' + String(e).slice(0, 200)));
  await page.goto('/');
  await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });
  const mediaLabel = page.locator('label').filter({ has: page.getByRole('radio', { name: /素材库/ }) }).first();
  await mediaLabel.click({ force: true });
  const winbox = page.locator('.winbox-media-library');
  await expect(winbox).toBeVisible({ timeout: 15000 });
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await winbox.locator('input[type="file"]').setInputFiles([{ name: 'p.png', mimeType: 'image/png', buffer: png1x1 }]);
  const uploaded = winbox.locator('.asset-item').first();
  await expect(uploaded).toBeVisible({ timeout: 15000 });
  await uploaded.hover();
  await winbox.locator('button[aria-label="插入到画布"]').first().click({ force: true });
  await expect(page.locator('.t-message', { hasText: '素材已插入到画板' })).toBeVisible({ timeout: 15000 });
  await winbox.locator('.wb-close').click().catch(() => {});
  await page.waitForTimeout(400);
  const canvasImg = page.locator('.viewport-container foreignObject img').first();
  await expect(canvasImg).toBeVisible({ timeout: 15000 });
  let box = await canvasImg.boundingBox();
  // 选图→编辑图片→进编辑态
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.click(cx, cy);
  const editBtn = page.getByTestId('popup-toolbar').getByRole('button', { name: '编辑图片' });
  await expect(editBtn).toBeVisible({ timeout: 10000 });
  await editBtn.click({ force: true });
  await expect(page.getByTestId('canvas-edit-banner')).toBeVisible({ timeout: 10000 });
  // 编辑态内拖拽图片 100px
  box = await canvasImg.boundingBox();
  const sx = box!.x + box!.width / 2;
  const sy = box!.y + box!.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 100, sy + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after = await canvasImg.boundingBox();
  const moved = Math.abs(after!.x - box!.x) > 30 || Math.abs(after!.y - box!.y) > 30;
  // 同时记录画布容器类名(看是否 readonly 之类)
  const hostCls = await page.evaluate(() => document.querySelector('.plait-board-container')?.className ?? '');
  writeFileSync('probe-move-result.txt', 'moved=' + moved + ' errs=' + errs.slice(0,4).join('|'));
  throw new Error(`PROBE moved=${moved} dx=${(after!.x - box!.x).toFixed(0)} dy=${(after!.y - box!.y).toFixed(0)} host=${hostCls}`);
});

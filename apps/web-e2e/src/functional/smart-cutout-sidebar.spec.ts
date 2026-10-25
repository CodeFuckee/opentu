/**
 * 侧边栏「智能抠图」入口 E2E(@functional,服务 mock)
 *
 * 与 smart-cutout.spec(编辑器内入口)互补,覆盖侧边栏新入口:
 * - P0 选中画布图片 → 点侧边栏「智能抠图」→ 编辑器直落抠图模式(无需手动
 *   切 tab,encode 自动触发)→ 点选 → 掩码 → 确认 → 插入 → 画布 +1;
 * - P1 未选中任何元素点工具 → 提示 + 自动打开素材库引导;
 * - P1 多选两张点工具 → 提示只选一张。
 * 推理服务全程 route mock(与 smart-cutout.spec 同款),不依赖 GPU 服务。
 */
import { deflateSync } from 'node:zlib';
import { disableCloudPullForLocalIsolation } from '../fixtures/cloud-sync-helpers';
import { test, expect } from '../fixtures/test-base';

// 云端唯一存储默认开启后，共享账号池的云端历史数据会进入视图——本 spec 依赖
// 干净的空画布起点，统一在此接入本地隔离（旧路径＋不拉取，见 cloud-sync-helpers）
test.beforeEach(async ({ page }) => {
  await disableCloudPullForLocalIsolation(page);
});


function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c;
  }
  let crc = 0xffffffff;
  for (const b of Buffer.concat([typeBuf, data])) {
    crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  }
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 8x6 全白 RGB PNG(运行时生成):cutout-utils 按 R 通道>128 判选中,全白=全选 */
function makeWhiteMaskPngB64(width: number, height: number): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 255);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

const WHITE_PNG_B64 = makeWhiteMaskPngB64(8, 6);
const SESSION_ID = 'e2e-cutout-0002-0000-000000000000';

/** mock image-segmentation edge function,记录调用 */
async function mockSegmentation(page: import('@playwright/test').Page) {
  const calls: Array<{ action: string; points?: unknown }> = [];
  await page.route('**/functions/v1/image-segmentation*', async (route) => {
    const body = route.request().postDataJSON() as { action?: string } | null;
    const action = body?.action ?? 'unknown';
    calls.push({ action, points: (body as { points?: unknown })?.points });
    if (action === 'encode') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: SESSION_ID,
          width: 800,
          height: 600,
          device: 'mock',
          encodeMs: 5,
        }),
      });
      return;
    }
    if (action === 'segment') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          maskPngB64: WHITE_PNG_B64,
          score: 0.99,
          maskWidth: 8,
          maskHeight: 6,
          decodeMs: 5,
        }),
      });
      return;
    }
    await route.fulfill({ status: 400, body: JSON.stringify({ error: 'bad_request' }) });
  });
  return calls;
}

/** 打开官方素材库并把第一张卡片插入画布,然后关闭窗口 */
async function insertOfficialImage(page: import('@playwright/test').Page) {
  const mediaLabel = page
    .locator('label')
    .filter({ has: page.getByRole('radio', { name: /素材库/ }) })
    .first();
  await mediaLabel.click({ force: true });
  const winbox = page.locator('.winbox-media-library');
  await expect(winbox).toBeVisible({ timeout: 15000 });
  await page.getByTestId('media-library-mode-official').click();
  const view = page.getByTestId('official-library-view');
  await expect(view).toBeVisible({ timeout: 20000 });
  const card = page.locator('.asset-item').first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.hover();
  const insertBtn = winbox.locator('button[aria-label="插入到画布"]').first();
  await insertBtn.waitFor({ state: 'visible', timeout: 8000 });
  await insertBtn.dispatchEvent('click');
  await winbox.locator('.wb-close').dispatchEvent('click');
  await page.waitForTimeout(600);
}

/** 侧边栏「智能抠图」工具按钮(ToolButton 渲染为 radio+label,与素材库入口同款) */
const SIDEBAR_CUTOUT_BTN = (page: import('@playwright/test').Page) =>
  page
    .locator('label')
    .filter({ has: page.getByRole('radio', { name: '智能抠图' }) })
    .first();

test.describe('侧边栏智能抠图', () => {
  test('P0 选中画布图片 → 直落抠图模式 → 点选确认 → 插入画布 +1', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const calls = await mockSegmentation(page);

    await page.goto('/');
    for (let i = 0; i < 10; i++) {
      if (
        await page
          .getByRole('button', { name: '不再提示' })
          .isVisible({ timeout: 500 })
          .catch(() => false)
      ) {
        await page.getByRole('button', { name: '不再提示' }).click();
        break;
      }
    }
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });

    await insertOfficialImage(page);

    // ---- 单击选中画布图片(popup-toolbar 出现即选中态) ----
    const canvasImgs = page.locator('.viewport-container foreignObject img');
    await expect(canvasImgs.first()).toBeVisible({ timeout: 15000 });
    const imgCountBefore = await canvasImgs.count();
    const imgBox = await canvasImgs.first().boundingBox();
    expect(imgBox?.width ?? 0).toBeGreaterThan(0);
    await page.mouse.click(imgBox!.x + imgBox!.width / 2, imgBox!.y + imgBox!.height / 2);

    // ---- 点侧边栏「智能抠图」→ 编辑器打开且已落在抠图模式 ----
    await SIDEBAR_CUTOUT_BTN(page).click();
    const editor = page.locator('.image-editor-core').first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('cutout-mode-tab')).toHaveClass(/active/, {
      timeout: 10000,
    });
    await expect(page.getByTestId('cutout-stage')).toBeVisible({ timeout: 10000 });
    // 直落抠图模式:未手动切 tab,encode 应已自动触发
    await expect
      .poll(() => calls.filter((c) => c.action === 'encode').length, { timeout: 15000 })
      .toBeGreaterThanOrEqual(1);

    // ---- 点选目标 → 掩码出现 ----
    const stageImg = page.getByTestId('cutout-stage').locator('img').first();
    await expect(stageImg).toBeVisible({ timeout: 10000 });
    const box = await stageImg.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.getByTestId('cutout-mask-overlay')).toBeVisible({ timeout: 15000 });

    // ---- 确认 → 插入新图片 → 画布 +1 ----
    await page.getByTestId('cutout-confirm').click();
    const saveDialog = page.locator('.image-editor-core__save-dialog');
    await expect(saveDialog).toBeVisible({ timeout: 15000 });
    await saveDialog.getByRole('button', { name: /插入新图片/ }).click();
    await expect(canvasImgs).toHaveCount(imgCountBefore + 1, { timeout: 20000 });
  });

  test('P1 未选中任何元素 → 提示并自动打开素材库', async ({ page }) => {
    test.setTimeout(120_000);
    await mockSegmentation(page);

    await page.goto('/');
    for (let i = 0; i < 10; i++) {
      if (
        await page
          .getByRole('button', { name: '不再提示' })
          .isVisible({ timeout: 500 })
          .catch(() => false)
      ) {
        await page.getByRole('button', { name: '不再提示' }).click();
        break;
      }
    }
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });

    await SIDEBAR_CUTOUT_BTN(page).click();

    // 引导提示 + 素材库自动打开
    await expect(
      page.getByText('请先在画布选中一张图片').first()
    ).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.winbox-media-library')).toBeVisible({ timeout: 15000 });
  });

  test('P1 多选两张图片 → 提示只选一张', async ({ page }) => {
    test.setTimeout(120_000);
    await mockSegmentation(page);

    await page.goto('/');
    for (let i = 0; i < 10; i++) {
      if (
        await page
          .getByRole('button', { name: '不再提示' })
          .isVisible({ timeout: 500 })
          .catch(() => false)
      ) {
        await page.getByRole('button', { name: '不再提示' }).click();
        break;
      }
    }
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });

    // 插入两张图(同一位置叠放,后插者在顶层)
    await insertOfficialImage(page);
    await insertOfficialImage(page);
    const canvasImgs = page.locator('.viewport-container foreignObject img');
    await expect(canvasImgs).toHaveCount(2, { timeout: 20000 });

    // 拖顶层(img[1])到槽位 B → 原位露出 img[0] → 再拖 img[0] 到槽位 A。
    // 只依赖「顶层可见且可抓取」,不假设插入位置(CI 视口上插图可能带滚动)
    const dragBy = async (
      from: { x: number; y: number; width: number; height: number },
      tx: number,
      ty: number
    ) => {
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(tx, ty, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    };
    const topBox = await canvasImgs.nth(1).boundingBox();
    expect(topBox).toBeTruthy();
    await dragBy(topBox!, 700, 400);
    // 「自适应」缩放把两张图都带回视口(插入可能伴随滚动,img[0] 或在视口外)
    await page.getByTestId('zoom-display').click();
    await page.locator('[data-track="view_nav_zoom_fit"]').click();
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    const underBox = await canvasImgs.nth(0).boundingBox();
    expect(underBox).toBeTruthy();
    await dragBy(underBox!, 250, 180);

    // 拖完后两张必须都在视口内且分离,否则后续点击不可靠
    const box1 = await canvasImgs.nth(0).boundingBox();
    const box2 = await canvasImgs.nth(1).boundingBox();
    expect(box1 && box2).toBeTruthy();
    for (const b of [box1!, box2!]) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(1280);
      expect(b.y + b.height).toBeLessThanOrEqual(720);
    }
    const separated =
      box1!.x + box1!.width < box2!.x || box2!.x + box2!.width < box1!.x ||
      box1!.y + box1!.height < box2!.y || box2!.y + box2!.height < box1!.y;
    expect(separated).toBe(true);

    // 点击第一张,再 shift+点击第二张 → 多选
    await page.mouse.click(box1!.x + box1!.width / 2, box1!.y + box1!.height / 2);
    await page.keyboard.down('Shift');
    await page.mouse.click(box2!.x + box2!.width / 2, box2!.y + box2!.height / 2);
    await page.keyboard.up('Shift');

    await SIDEBAR_CUTOUT_BTN(page).click();
    await expect(
      page.getByText('请只选中一张图片').first()
    ).toBeVisible({ timeout: 10000 });
    // 编辑器不应打开
    await expect(page.locator('.image-editor-core')).toHaveCount(0, { timeout: 5000 });
  });
});

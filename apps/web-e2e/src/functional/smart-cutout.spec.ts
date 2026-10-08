/**
 * #41 智能抠图 E2E(@functional,服务 mock)
 *
 * 覆盖 UI 全链路:官方素材库双击开预览 →「编辑图片」→ 抠图 tab → 自动编码
 * → 点击目标 → 掩码覆盖层 → 确认抠图 → 保存选项 →「插入新图片」→ 画布出现
 * 抠图结果。推理服务(segment-server/image-segmentation)全程 route mock,
 * CI 不依赖 GPU 服务;真服务链路由部署后 LAN 过目验证(见 openspec tasks)。
 */
import { deflateSync } from 'node:zlib';
import { test, expect } from '../fixtures/test-base';

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

const SESSION_ID = 'e2e-cutout-0001-0000-000000000000';

test.describe('智能抠图', () => {
  test('编辑器抠图全链路(mock 推理服务)', async ({ page }) => {
    test.setTimeout(180_000);

    // ---- mock image-segmentation edge function ----
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

    // ---- 打开官方素材库,插图到画布(悬浮按钮为 onClick,双击=开无编辑器的库内预览) ----
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

    // ---- 双击画布图片 → 媒体预览(内置编辑器 + 插回画布) ----
    const canvasImgs = page.locator('.viewport-container foreignObject img');
    await expect(canvasImgs.first()).toBeVisible({ timeout: 15000 });
    const imgCountBefore = await canvasImgs.count();
    const imgBox = await canvasImgs.first().boundingBox();
    expect(imgBox?.width ?? 0).toBeGreaterThan(0);
    await page.mouse.dblclick(imgBox!.x + imgBox!.width / 2, imgBox!.y + imgBox!.height / 2);

    // 预览器工具栏的编辑按钮(画布选中弹层也有同名 aria-label,必须限定在 .unified-viewer 内)
    const editBtn = page
      .locator('.unified-viewer button[aria-label="编辑图片"]')
      .first();
    await expect(editBtn).toBeVisible({ timeout: 15000 });
    // HoverPopover 气泡可能盖住按钮中心,直接派发 click(React 合成事件正常接收)
    await editBtn.dispatchEvent('click');
    const editor = page.locator('.image-editor-core').first();
    await expect(editor).toBeVisible({ timeout: 15000 });

    // ---- 抠图 tab:自动编码(mock) ----
    await page.getByTestId('cutout-mode-tab').click();
    await expect(page.getByTestId('cutout-panel')).toBeVisible({ timeout: 10000 });
    const stage = page.getByTestId('cutout-stage');
    await expect(stage).toBeVisible({ timeout: 10000 });
    await expect
      .poll(() => calls.filter((c) => c.action === 'encode').length, { timeout: 15000 })
      .toBeGreaterThanOrEqual(1);

    const stageImg = stage.locator('img').first();
    await expect(stageImg).toBeVisible({ timeout: 10000 });
    const box = await stageImg.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);

    // ---- 悬停即预览:仅移动鼠标(不点击)就应出现悬停掩码层 ----
    await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.3);
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    await expect(page.getByTestId('cutout-hover-overlay')).toBeVisible({ timeout: 15000 });

    // ---- 点击锁定:正式掩码层出现、悬停层让位 ----
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.getByTestId('cutout-mask-overlay')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('cutout-hover-overlay')).toBeHidden({ timeout: 5000 });
    await expect
      .poll(() => calls.filter((c) => c.action === 'segment').length, { timeout: 15000 })
      .toBeGreaterThanOrEqual(1);
    const segmentCall = calls.find((c) => c.action === 'segment');
    expect(Array.isArray(segmentCall?.points)).toBeTruthy();
    expect((segmentCall!.points as number[][]).length).toBeGreaterThanOrEqual(1);

    // ---- 确认抠图 → 保存选项 → 插入新图片 ----
    await page.getByTestId('cutout-confirm').click();
    const saveDialog = page.locator('.image-editor-core__save-dialog');
    await expect(saveDialog).toBeVisible({ timeout: 15000 });
    await saveDialog.getByRole('button', { name: /插入新图片/ }).click();

    // ---- 画布多出抠图结果(原图仍在,数量应 +1) ----
    await expect(canvasImgs).toHaveCount(imgCountBefore + 1, { timeout: 20000 });
    const insertBox = await canvasImgs.nth(imgCountBefore).boundingBox();
    expect(insertBox?.width ?? 0).toBeGreaterThan(0);
  });
});

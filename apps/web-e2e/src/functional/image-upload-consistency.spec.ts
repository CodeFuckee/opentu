/**
 * 图片上传入口 25MB 校验一致性测试（@functional）
 *
 * 背景：各图片上传入口对超大图应有一致的校验行为——
 *   - >25MB：提示「图片大小不能超过 25MB」并拒绝（不压缩、不添加）
 *   - 10–25MB：接受并走压缩档（有压缩提示）
 *   - ≤10MB：直接接受
 * 本套件逐入口验证该行为，并如实暴露已知不一致缺口（批量生图无校验、
 * AIInputBar 素材库选择路径无校验），不修改程序代码。
 *
 * 测试素材：测试内零依赖生成随机纹理 PNG（zlib level 0 存储块，
 * 字节大小 ≈ 宽×高×3，不可被 deflate 压缩），三档：
 *   - 小图 512×512   ≈ 0.75MB（≤10MB）
 *   - 中图 2048×2048 ≈ 12.0MB（>10MB 压缩档）
 *   - 大图 3072×3072 ≈ 27MB（>25MB 拒绝档）
 *
 * 明确不测：真实任务提交（避免消耗生成额度）；25MB±1B 精确边界；
 * 画布级图片插入（属插入不属上传，无校验是既定设计）。
 *
 * 用户实测场景复现（E2E-IMG-12/13，真实大图 test-files/big_test_data.jpg）：
 *   - 画布直接粘贴 >25MB（不聚焦 AI 输入条）→ 无校验插入画布
 *   - 左侧边栏「图片」工具选择 >25MB → 无校验插入画布
 * 与 E2E-IMG-02（聚焦输入条后粘贴被拒）对比，共同解释「粘贴行为不一致」的观感。
 *
 * 运行：npx playwright test src/functional/image-upload-consistency.spec.ts --project=functional
 */
import { deflateSync } from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../fixtures/test-base';
import {
  dismissInspirationBoard,
  drawRectangle,
  selectCenterElement,
  elementCount,
  focusCanvasEmptyArea,
  screenAt,
  pressToolKey,
} from '../fixtures/canvas-helpers';
import type { Page } from '@playwright/test';

/** 用户提供的真实大图（50.67MB JPEG），用于复现「直接粘贴/左侧边栏上传 >25MB 被接受」 */
const BIG_TEST_JPG_CANDIDATES = [
  path.resolve(process.cwd(), '../../test-files/big_test_data.jpg'), // cwd = apps/web-e2e
  path.resolve(process.cwd(), 'test-files/big_test_data.jpg'), // cwd = 仓库根
  path.resolve(__dirname, '../../../test-files/big_test_data.jpg'),
];
const BIG_TEST_JPG_PATH =
  BIG_TEST_JPG_CANDIDATES.find((p) => fs.existsSync(p)) ??
  BIG_TEST_JPG_CANDIDATES[0];

// ---------------- 常量 ----------------

const LIMIT_25MB = 25 * 1024 * 1024;
const BAND_10MB = 10 * 1024 * 1024;
const SMALL = { w: 512, h: 512 }; // ≈0.75MB
const MID = { w: 2048, h: 2048 }; // ≈12.0MB
const LARGE = { w: 3072, h: 3072 }; // ≈27MB

// ---------------- PNG 生成器（零依赖） ----------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 生成 width×height 的 RGB PNG。
 * 像素用确定性的纹理图案填充，IDAT 用 zlib level 0（存储块）——
 * 不做任何压缩，最终文件字节大小 ≈ 宽×高×3 + 头部，保证跨过 10MB/25MB 阈值，
 * 同时是完全合法可解码的 PNG。
 */
function makeSizedPng(width: number, height: number): Buffer {
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  // 每行：1 字节 filter(none) + RGB 像素；用周期纹理填充（内容不影响存储块大小）
  const pattern = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) {
    pattern[i] = (i * 7 + (i % 13) * 19) % 256;
  }
  for (let y = 0; y < height; y++) {
    const off = y * rowBytes;
    raw[off] = 0;
    for (let x = 1; x < rowBytes; x += 256) {
      pattern.copy(raw, off + x, 0, Math.min(256, rowBytes - x));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const idat = deflateSync(raw, { level: 0 });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 每 worker 惰性生成一次（大图 ~85MB 中间内存，避免每条用例重复生成）
let pngSmall: Buffer | null = null;
let pngMid: Buffer | null = null;
let pngLarge: Buffer | null = null;
let largePngBase64Str: string | null = null;

function smallPng(): Buffer {
  if (!pngSmall) pngSmall = makeSizedPng(SMALL.w, SMALL.h);
  return pngSmall;
}
function midPng(): Buffer {
  if (!pngMid) pngMid = makeSizedPng(MID.w, MID.h);
  return pngMid;
}
function largePng(): Buffer {
  if (!pngLarge) pngLarge = makeSizedPng(LARGE.w, LARGE.h);
  return pngLarge;
}
/** 粘贴用：base64 字符串透传（Buffer 直接作为 evaluate 参数会撑爆 worker 堆内存） */
function largePngAsBase64(): string {
  if (!largePngBase64Str) largePngBase64Str = largePng().toString('base64');
  return largePngBase64Str;
}

// 素材尺寸自检（套件级一次）：三档必须落在预期区间
test.beforeAll(async () => {
  const small = smallPng().length;
  const mid = midPng().length;
  const large = largePng().length;
  expect(small).toBeLessThan(BAND_10MB);
  expect(mid).toBeGreaterThan(BAND_10MB);
  expect(mid).toBeLessThan(LIMIT_25MB);
  expect(large).toBeGreaterThan(LIMIT_25MB);
});

// ---------------- 通用辅助 ----------------

/** 拒绝提示（覆盖两个入口的措辞变体） */
function rejectToast(page: Page) {
  return page.getByText(/图片(大小)?不能超过\s*25MB/).first();
}

/** 向页面派发带图片文件的 paste 事件（Chromium 支持 ClipboardEvent 构造器）
 *  图片数据以 base64 字符串透传，在浏览器侧解码，避免大 Buffer 序列化 OOM */
async function pasteImage(
  page: Page,
  targetSelector: string,
  base64: string,
  filename: string
) {
  await page.evaluate(
    ({ base64, filename, targetSelector }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], filename, { type: 'image/png' }));
      const target =
        (document.querySelector(targetSelector) as HTMLElement | null) ??
        document.body;
      const event = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
    },
    { base64, filename, targetSelector }
  );
}

async function openHome(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('unified-toolbar')).toBeVisible({
    timeout: 15000,
  });
  await dismissInspirationBoard(page);
}

/** 分块把真实大文件送进浏览器并派发带 File 的 paste 事件
 *  （大文件以 base64 分块传输，避免单次大 Buffer 作为 evaluate 参数导致 worker OOM） */
async function pasteRealFile(
  page: Page,
  targetSelector: string,
  filePath: string,
  filename: string,
  mimeType: string
) {
  const base64 = fs.readFileSync(filePath).toString('base64');
  const CHUNK = 8 * 1024 * 1024;
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__e2ePasteChunks = [];
  });
  for (let i = 0; i < base64.length; i += CHUNK) {
    const part = base64.slice(i, i + CHUNK);
    await page.evaluate((part) => {
      (window as unknown as { __e2ePasteChunks: string[] }).__e2ePasteChunks.push(
        part
      );
    }, part);
  }
  await page.evaluate(
    ({ filename, mimeType, targetSelector }) => {
      const chunks =
        (window as unknown as { __e2ePasteChunks: string[] }).__e2ePasteChunks ??
        [];
      const joined = chunks.join('');
      delete (window as unknown as Record<string, unknown>).__e2ePasteChunks;
      const bytes = Uint8Array.from(atob(joined), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], filename, { type: mimeType }));
      const target =
        (document.querySelector(targetSelector) as HTMLElement | null) ??
        document.body;
      target.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        })
      );
    },
    { filename, mimeType, targetSelector }
  );
}

// ---------------- 入口 1/2：AI 输入条 ----------------

function aiBarInput(page: Page) {
  return page.getByTestId('ai-input-bar').locator('input[type="file"]');
}
function aiBarPreviews(page: Page) {
  return page
    .getByTestId('ai-input-bar')
    .locator('.selected-content-preview');
}

test.describe('AI 输入条上传', () => {
  test('E2E-IMG-01 文件选择 >25MB：提示拒绝且不添加', async ({ page }) => {
    // 桥接 2 核环境：画布重交互对 runner 负载时序敏感，内网 e2e 守护本用例
    test.skip(process.env.E2E_BRIDGE === '1', '桥接 2 核环境受限，内网 e2e 守护');
    await openHome(page);
    await aiBarInput(page).setInputFiles({
      name: 'large-27mb.png',
      mimeType: 'image/png',
      buffer: largePng(),
    });

    // >25MB 文件的解码/校验在慢环境下也慢（CI 并发实测 22s 窗曾不够）
    await expect(rejectToast(page)).toBeVisible({ timeout: 25000 });
    await expect(aiBarPreviews(page)).toHaveCount(0);
  });

  test('E2E-IMG-02 粘贴 >25MB：提示拒绝且不添加', async ({ page }) => {
    // 桥接 2 核环境：画布重交互对 runner 负载时序敏感，内网 e2e 守护本用例
    test.skip(process.env.E2E_BRIDGE === '1', '桥接 2 核环境受限，内网 e2e 守护');
    await openHome(page);
    // 粘贴处理要求焦点在输入条容器内
    await page.getByTestId('ai-input-textarea').click();
    await pasteImage(
      page,
      '[data-testid="ai-input-textarea"]',
      largePngAsBase64(),
      'paste-large.png'
    );

    await expect(rejectToast(page)).toBeVisible({ timeout: 10000 });
    await expect(aiBarPreviews(page)).toHaveCount(0);
  });

  test('E2E-IMG-03 文件选择 10–25MB：走压缩档并被接受', async ({ page }) => {
    // 桥接 2 核环境：画布重交互对 runner 负载时序敏感，内网 e2e 守护本用例
    test.skip(process.env.E2E_BRIDGE === '1', '桥接 2 核环境受限，内网 e2e 守护');
    test.setTimeout(120000);
    await openHome(page);
    await aiBarInput(page).setInputFiles({
      name: 'mid-12mb.png',
      mimeType: 'image/png',
      buffer: midPng(),
    });

    // 压缩完成提示（压缩目标是 5MB，纹理图可能压不到位，但成功提示必然出现）。
    // 冷启动/慢环境下 canvas 压缩明显变慢（CI 多浏览器并发抢 CPU 实测超 60s），
    // 给足 120s
    await expect(page.getByText(/压缩完成/).first()).toBeVisible({
      timeout: 120000,
    });
    await expect(aiBarPreviews(page).first()).toBeVisible({ timeout: 15000 });
  });

  test('E2E-IMG-04 文件选择 ≤10MB：直接接受，无压缩提示', async ({ page }) => {
    // 桥接 2 核环境：画布重交互对 runner 负载时序敏感，内网 e2e 守护本用例
    test.skip(process.env.E2E_BRIDGE === '1', '桥接 2 核环境受限，内网 e2e 守护');
    await openHome(page);
    await aiBarInput(page).setInputFiles({
      name: 'small-1mb.png',
      mimeType: 'image/png',
      buffer: smallPng(),
    });

    await expect(aiBarPreviews(page).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/压缩/)).toHaveCount(0);
  });
});

// ---------------- 入口 3/4：AI 生图对话框（ReferenceImageUpload） ----------------

async function openAiImageDialog(page: Page) {
  await openHome(page);
  await page.locator('[data-track="toolbar_click_ai-image"]').click();
  const dialog = page.locator('.ai-image-generation-container');
  await expect(dialog).toBeVisible({ timeout: 10000 });
  return dialog;
}

test.describe('AI 生图对话框上传', () => {
  test('E2E-IMG-05 参考图文件选择 >25MB：提示拒绝且不添加', async ({ page }) => {
    // 桥接 2 核环境：画布重交互对 runner 负载时序敏感，内网 e2e 守护本用例
    test.skip(process.env.E2E_BRIDGE === '1', '桥接 2 核环境受限，内网 e2e 守护');
    const dialog = await openAiImageDialog(page);
    const input = dialog.locator('input.reference-image-upload__input');
    await input.setInputFiles({
      name: 'large-27mb.png',
      mimeType: 'image/png',
      buffer: largePng(),
    });

    await expect(rejectToast(page)).toBeVisible({ timeout: 10000 });
    await expect(dialog.locator('.reference-image-upload__image')).toHaveCount(0);
  });

  test('E2E-IMG-06 参考图粘贴 >25MB：提示拒绝且不添加', async ({ page }) => {
    // 桥接 2 核环境：画布重交互对 runner 负载时序敏感，内网 e2e 守护本用例
    test.skip(process.env.E2E_BRIDGE === '1', '桥接 2 核环境受限，内网 e2e 守护');
    const dialog = await openAiImageDialog(page);
    // 粘贴守卫要求焦点在参考图容器或 body 上：模拟用户点击对话框空白处后焦点回落 body
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
    });
    await pasteImage(page, 'body', largePngAsBase64(), 'paste-large.png');

    await expect(rejectToast(page)).toBeVisible({ timeout: 10000 });
    await expect(dialog.locator('.reference-image-upload__image')).toHaveCount(0);
  });
});

// ---------------- 入口 5：对话抽屉（EnhancedChatInput） ----------------

test.describe('对话抽屉上传', () => {
  test('E2E-IMG-07 聊天图片 >25MB：提示拒绝且不添加', async ({ page }) => {
    // 桥接 2 核环境：画布重交互对 runner 负载时序敏感，内网 e2e 守护本用例
    test.skip(process.env.E2E_BRIDGE === '1', '桥接 2 核环境受限，内网 e2e 守护');
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });
    await page.locator('[data-track="chat_click_drawer_open"]').first().click();
    const drawer = page.getByTestId('chat-drawer');
    await expect(drawer).toBeVisible({ timeout: 8000 });

    const input = drawer.locator('input[type="file"]');
    await input.setInputFiles({
      name: 'large-27mb.png',
      mimeType: 'image/png',
      buffer: largePng(),
    });

    await expect(
      page.getByText('图片不能超过 25MB').first()
    ).toBeVisible({ timeout: 10000 });
    // 未添加：抽屉内不出现已选图片预览
    await expect(drawer.locator('.selected-content-preview')).toHaveCount(0);
  });
});

// ---------------- 入口 6：局部重绘面板（ImageFillPanel） ----------------

test.describe('局部重绘面板上传', () => {
  test('E2E-IMG-08 图片填充 >25MB：提示拒绝', async ({ page }) => {
    // 桥接 2 核环境：画布重交互对 runner 负载时序敏感，内网 e2e 守护本用例
    test.skip(process.env.E2E_BRIDGE === '1', '桥接 2 核环境受限，内网 e2e 守护');
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });
    await dismissInspirationBoard(page);

    // 画布绘制矩形并选中，弹出工具条。
    // drawRectangle 后矩形处于选中态且指针仍是「形状」工具：
    // 先切回「选择」指针、点击空白处取消选中，再点矩形干净地选中
    // （对已选中图形单击会进入文本编辑，而不是保持选中）
    await drawRectangle(page);
    await pressToolKey(page, 'v', 'selection');
    await focusCanvasEmptyArea(page);
    await selectCenterElement(page);
    const popup = page.getByTestId('popup-toolbar');
    await expect(popup).toBeVisible();

    // 打开填充面板并切到「图片」填充页
    await popup.getByRole('button', { name: '填充颜色' }).first().click();
    const fillSetting = page.locator('.fill-setting');
    await expect(fillSetting).toBeVisible({ timeout: 8000 });
    await fillSetting.getByRole('button', { name: '图片', exact: true }).click();

    const input = page.locator('.image-fill-panel input[type="file"]');
    await expect(input).toBeAttached();
    await input.setInputFiles({
      name: 'large-27mb.png',
      mimeType: 'image/png',
      buffer: largePng(),
    });

    await expect(rejectToast(page)).toBeVisible({ timeout: 10000 });
    // 未采用：面板内不出现已设置图片的操作按钮态（图片容器保持空态点击行为）
    await expect(
      page.locator('.image-fill-panel .ifp-action-btn--danger, .image-fill-panel img')
    ).toHaveCount(0);
  });
});

// ---------------- 入口 7/8：批量生图 + 素材库（重窗口，独立清理） ----------------

const winboxMediaLibrary = '.winbox-media-library';

async function openMediaLibrary(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('unified-toolbar')).toBeVisible({
    timeout: 15000,
  });
  const mediaLabel = page
    .locator('label')
    .filter({ has: page.getByRole('radio', { name: /素材库/ }) })
    .first();
  await expect(mediaLabel).toBeVisible();
  const modal = page.locator(winboxMediaLibrary);
  for (let attempt = 0; attempt < 3; attempt++) {
    await mediaLabel.click({ force: true });
    try {
      await expect(modal).toBeVisible({ timeout: 4000 });
      return modal;
    } catch {
      // 未打开则重试
    }
  }
  await expect(modal).toBeVisible({ timeout: 8000 });
  return modal;
}

function assetItemByName(page: Page, name: string) {
  return page
    .locator(`${winboxMediaLibrary} .asset-item`)
    .filter({
      has: page.locator('.asset-item__name-overlay', { hasText: name }),
    });
}

test.describe('批量生图与素材库', () => {
  let uploadedPrefixes: string[] = [];

  /** 素材库用例清理：搜索前缀 → 批量选择 → 删除 */
  async function cleanupUploadedAssets(page: Page) {
    const modal = page.locator(winboxMediaLibrary);
    for (const prefix of uploadedPrefixes) {
      if (!(await modal.isVisible().catch(() => false))) {
        await openMediaLibrary(page);
      }
      const search = page.locator('[data-track="grid_search_input"] input');
      await search.fill(prefix);
      const items = modal.locator('.asset-item');
      let count = 0;
      try {
        await items.first().waitFor({ state: 'visible', timeout: 5000 });
        count = await items.count();
      } catch {
        count = 0;
      }
      if (count === 0) continue;

      await modal.locator('[data-track="grid_toggle_selection_mode"]').click();
      const selectAll = modal.locator('.media-library-grid__selection-info');
      await expect(selectAll).toBeVisible();
      await selectAll.click();
      const deleteBtn = modal.locator('[data-track="grid_batch_delete"]');
      await expect(deleteBtn).toBeEnabled();
      await deleteBtn.click();
      const confirmDelete = page
        .locator('.confirm-dialog')
        .getByRole('button', { name: '删除', exact: true });
      await expect(confirmDelete).toBeVisible();
      await confirmDelete.click();
      await expect(items).toHaveCount(0, { timeout: 10000 });
    }
    uploadedPrefixes = [];
  }

  test.afterEach(async ({ page }) => {
    await cleanupUploadedAssets(page);
  });

  test('E2E-IMG-09 批量生图 >25MB：预期不一致——无提示被接受（缺口）', async ({ page }) => {
    test.setTimeout(120000);
    await openHome(page);
    await page.getByTestId('toolbar-toolbox').click();
    const drawer = page.locator('.side-drawer--toolbar-right').first();
    await expect(drawer).toBeVisible({ timeout: 8000 });
    await drawer.getByText('批量出图工具').click();

    const batch = page.locator('.batch-image-generation');
    await expect(batch).toBeVisible({ timeout: 15000 });

    // 第一个图片 file input 是批量导入入口
    const importInput = batch
      .locator('input[type="file"][accept="image/*"]')
      .first();
    await importInput.setInputFiles({
      name: 'large-27mb.png',
      mimeType: 'image/png',
      buffer: largePng(),
    });

    // 缺口证据一：无 25MB 拒绝提示
    await page.waitForTimeout(2000);
    await expect(rejectToast(page)).toHaveCount(0);

    // 应用语义：导入需在确认弹窗中点「确认导入」
    const importModal = batch.locator('.batch-import-modal');
    await expect(importModal).toBeVisible({ timeout: 10000 });
    await expect(importModal).toContainText('已选择 1 张图片');
    // 缺口证据二：27MB 图片出现在导入预览中（缩略图解码成功）
    await expect(importModal.locator('img').first()).toBeVisible();

    await importModal.getByRole('button', { name: '确认导入' }).click();
    // 缺口证据三：导入成功提示（无任何大小校验拦截）
    await expect(
      page.getByText(/已导入 \d+ 张图片/).first()
    ).toBeVisible({ timeout: 20000 });
    await expect(rejectToast(page)).toHaveCount(0);
  });

  test('E2E-IMG-10 素材库上传 >25MB：被接受（100MB 上限对照组）', async ({ page }) => {
    test.setTimeout(180000);
    const prefix = `e2eimg25mb${Date.now().toString(36)}`;
    uploadedPrefixes.push(prefix);
    const modal = await openMediaLibrary(page);

    const input = page.locator(`${winboxMediaLibrary} input[type="file"]`);
    await input.setInputFiles({
      name: `${prefix}-large.png`,
      mimeType: 'image/png',
      buffer: largePng(),
    });

    // >25MB 但 ≤100MB：上传成功，素材出现在网格
    await expect(assetItemByName(page, `${prefix}-large.png`)).toBeVisible({
      timeout: 30000,
    });
  });

  test('E2E-IMG-11 素材库→AI输入条选择 >25MB：预期不一致——选择时无校验（缺口）', async ({ page }) => {
    test.setTimeout(180000);
    const prefix = `e2eimg25mb${Date.now().toString(36)}`;
    uploadedPrefixes.push(prefix);

    // 先把 >25MB 素材入库（合法，见 E2E-IMG-10）
    const modal = await openMediaLibrary(page);
    const input = page.locator(`${winboxMediaLibrary} input[type="file"]`);
    await input.setInputFiles({
      name: `${prefix}-select.png`,
      mimeType: 'image/png',
      buffer: largePng(),
    });
    await expect(assetItemByName(page, `${prefix}-select.png`)).toBeVisible({
      timeout: 30000,
    });

    // 关闭素材库，回到 AI 输入条打开素材库选择器
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden({ timeout: 5000 }).catch(async () => {
      await page.goto('/');
      await expect(page.getByTestId('unified-toolbar')).toBeVisible();
    });

    await page.getByTestId('ai-input-bar').locator('.ai-input-bar__library-btn').click();
    await expect(page.locator(winboxMediaLibrary)).toBeVisible({ timeout: 8000 });

    // 点击素材使其进入右侧检查器，再点「使用」回传给 AI 输入条
    await assetItemByName(page, `${prefix}-select.png`).first().click();
    const useBtn = page
      .locator(winboxMediaLibrary)
      .getByRole('button', { name: '使用', exact: true })
      .first();
    await expect(useBtn).toBeVisible({ timeout: 10000 });
    await useBtn.click();

    // 预期缺口：全程不出现任何大小校验错误，>25MB 图片直接进入输入条
    await expect(rejectToast(page)).toHaveCount(0);
    await expect(aiBarPreviews(page).first()).toBeVisible({ timeout: 15000 });
  });
});

// ---------------- 用户实测场景复现（真实大图 test-files/big_test_data.jpg） ----------------

test.describe('用户实测场景复现（>25MB 被接受的路径）', () => {
    test('E2E-IMG-12 画布直接粘贴 >25MB：不聚焦 AI 输入条时无校验、直接插入画布', async ({ page }) => {
      test.skip(fs.existsSync(BIG_TEST_JPG_PATH) === false, `缺少测试文件 ${BIG_TEST_JPG_PATH}`);
      test.setTimeout(240000);
      await openHome(page);

      // 画布粘贴守卫要求 board.selection 非空（空白新画布上粘贴会被静默忽略）。
      // 先绘制一个矩形建立选中态，随后在画布上直接粘贴大图（与用户真实场景一致）
      await drawRectangle(page);
      const before = await elementCount(page);

      await pasteRealFile(page, 'body', BIG_TEST_JPG_PATH, 'big_test_data.jpg', 'image/jpeg');

      // 用户实测行为：>25MB 直接插入画布（元素 +1），全程无 25MB 拒绝提示
      await expect
        .poll(() => elementCount(page), { timeout: 60000, intervals: [500] })
        .toBeGreaterThan(before);
      await expect(rejectToast(page)).toHaveCount(0);
    });

  test('E2E-IMG-13 左侧边栏「图片」工具上传 >25MB：无校验、直接插入画布', async ({ page }) => {
    test.skip(fs.existsSync(BIG_TEST_JPG_PATH) === false, `缺少测试文件 ${BIG_TEST_JPG_PATH}`);
    test.setTimeout(240000);
    // 图片工具经 browser-fs-access fileOpen：优先走 showOpenFilePicker（原生对话框无法自动化）。
    // 在页面脚本执行前删除该 API（只删不赋值，"in" 检测属性存在性），
    // 库即回退到 <input type=file>，Playwright 可拦截 filechooser
    await page.addInitScript(() => {
      try {
        delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
      } catch {
        /* 属性不可配置时忽略 */
      }
    });
    await openHome(page);
    const before = await elementCount(page);

    // 左侧边栏「图片」工具（radio），点击其父级 label 触发文件选择
    const imageRadio = page.getByRole('radio', { name: /^图片/ }).first();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      imageRadio.locator('xpath=..').click({ force: true }),
    ]);
    await chooser.setFiles(BIG_TEST_JPG_PATH);

    // 用户实测行为：>25MB 直接插入画布（元素 +1），全程无 25MB 拒绝提示
    await expect
      .poll(() => elementCount(page), { timeout: 60000, intervals: [500] })
      .toBeGreaterThan(before);
    await expect(rejectToast(page)).toHaveCount(0);
  });

  // 已知 bug（2026-09-17 实测复现）：空白画布（无元素、board.selection 为空）直接粘贴
  // >25MB 图片被静默忽略——不插入、无提示、无报错（50.67MB 真实文件连续 3 次尝试均忽略）。
  // 期望行为：粘贴应插入画布（或至少给出失败反馈）。
  // 应用修复后：移除 fixme 标记，本用例即转为正式回归断言。
  test.fixme(
    'E2E-IMG-14 空白画布直接粘贴 >25MB：应插入画布而非静默忽略（bug 修复后启用）',
    async ({ page }) => {
      test.skip(
        fs.existsSync(BIG_TEST_JPG_PATH) === false,
        `缺少测试文件 ${BIG_TEST_JPG_PATH}`
      );
      test.setTimeout(300000);
      await page.goto('/');
      await expect(page.getByTestId('unified-toolbar')).toBeVisible({
        timeout: 15000,
      });
      await dismissInspirationBoard(page);
      await page.waitForTimeout(1500); // 等待应用水合

      // 空白画布（无任何元素）直接粘贴，重试 3 次以排除偶发时序因素
      const inserted = await (async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await focusCanvasEmptyArea(page);
          const { x, y } = screenAt(page, 0, 0);
          await page.mouse.move(x, y, { steps: 4 });
          const before = await elementCount(page);
          await pasteRealFile(
            page,
            'body',
            BIG_TEST_JPG_PATH,
            'big_test_data.jpg',
            'image/jpeg'
          );
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            if ((await elementCount(page)) > before) return true;
            await page.waitForTimeout(500);
          }
        }
        return false;
      })();

      // 画布路径无 25MB 校验提示（缺口固化）
      await expect(rejectToast(page)).toHaveCount(0);
      // 期望行为：>25MB 粘贴应插入画布（修复前：被静默忽略，三次均无插入）
      expect(inserted, '空白画布粘贴 >25MB 应插入画布，而非静默忽略').toBe(true);
    }
  );
});

/**
 * 素材库图片可见性测试（@functional）
 *
 * 覆盖：上传图片后在素材库对话框中的真实可见性 ——
 * 1. 单张上传后网格 <img> 解码成功（naturalWidth > 0）且无「加载失败」错误态；
 * 2. 批量上传 3 张全部可见；
 * 3. 双击预览大图加载成功并可关闭；
 * 4. 刷新页面后图片持久化仍可见（IndexedDB + SW 缓存回放）；
 * 5. 紧凑/列表视图切换后图片仍可见。
 *
 * 数据策略：每条用例用唯一前缀（e2eimg<runid>）上传程序自绘 PNG，
 * afterEach 通过「搜索前缀 → 批量选择 → 删除」清理本次上传的素材，不残留。
 *
 * 运行：npx playwright test --project=functional src/functional/media-library-images.spec.ts
 */
import { deflateSync } from 'zlib';
import { test, expect } from '../fixtures/test-base';
import type { Page, Locator } from '@playwright/test';

// ---------------- PNG 生成器（零依赖，自绘纯色 PNG） ----------------

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
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

/** 生成 width×height 纯色 PNG（RGB，8bit），用于上传测试素材 */
function makeSolidPng(
  width: number,
  height: number,
  rgb: [number, number, number]
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB

  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- 公共操作 ----------------

/** 打开素材库对话框（默认先回首页） */
async function openMediaLibrary(page: Page, { goto = true } = {}) {
  if (goto) {
    await page.goto('/');
  }
  await expect(page.getByTestId('unified-toolbar')).toBeVisible({
    timeout: 15000,
  });

  const mediaLabel = page
    .locator('label')
    .filter({ has: page.getByRole('radio', { name: /素材库/ }) })
    .first();
  await expect(mediaLabel).toBeVisible();
  await mediaLabel.click({ force: true });
  await expect(page.locator('.winbox-media-library')).toBeVisible({
    timeout: 8000,
  });
}

/** 按素材名定位网格素材项（网格视图名称浮层） */
function assetItemByName(page: Page, name: string): Locator {
  return page
    .locator('.winbox-media-library .asset-item')
    .filter({
      has: page.locator('.asset-item__name-overlay', { hasText: name }),
    });
}

/** 上传 PNG 文件并等待每个素材项出现在网格中 */
async function uploadPngs(
  page: Page,
  files: { name: string; buffer: Buffer }[]
) {
  const input = page.locator('.winbox-media-library input[type="file"]');
  await input.setInputFiles(
    files.map((f) => ({ name: f.name, mimeType: 'image/png', buffer: f.buffer }))
  );
  for (const f of files) {
    await expect(assetItemByName(page, f.name)).toBeVisible({
      timeout: 15000,
    });
  }
}

/**
 * 断言 scope 内每个素材项的图片真实解码成功：
 * img 可见、naturalWidth > 0（真实渲染而非占位）、无「加载失败」错误态。
 * 可选断言素材项数量。
 */
async function expectAllImagesDecoded(
  scope: Locator,
  expectedCount?: number,
  timeout = 15000
) {
  if (expectedCount !== undefined) {
    await expect(scope).toHaveCount(expectedCount, { timeout });
  }
  const count = await scope.count();
  for (let i = 0; i < count; i++) {
    const item = scope.nth(i);
    const img = item.locator('img.lazy-image__img');
    await expect(img).toBeVisible({ timeout });
    await expect
      .poll(
        () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout, message: `第 ${i + 1} 个素材图片未成功解码` }
      )
      .toBeGreaterThan(0);
    await expect(item.locator('.lazy-image__error')).toHaveCount(0);
  }
}

/** 读取「图片」类型筛选 tab 计数（aria-label="图片：N"） */
async function imageTypeCount(page: Page): Promise<number> {
  const tab = page.locator(
    '.winbox-media-library button[aria-label^="图片："]'
  );
  await expect(tab).toBeVisible({ timeout: 8000 });
  const label = (await tab.getAttribute('aria-label')) ?? '';
  const m = label.match(/图片：(\d+)/);
  return m ? Number(m[1]) : -1;
}

// ---------------- 用例 ----------------

test.describe('素材库图片可见性', () => {
  // 本次测试上传的素材唯一前缀，afterEach 统一清理
  let uploadedPrefixes: string[] = [];

  test.beforeEach(() => {
    uploadedPrefixes = [];
  });

  /** 清理本次上传的素材：搜索前缀 → 批量选择 → 删除 → 确认 */
  async function cleanupUploadedAssets(page: Page) {
    const modal = page.locator('.winbox-media-library');
    for (const prefix of uploadedPrefixes) {
      // 测试中途 reload 会关闭窗口，重新打开（已在首页无需 goto）
      if (!(await modal.isVisible().catch(() => false))) {
        await openMediaLibrary(page, { goto: false });
      }

      const search = page.locator('[data-track="grid_search_input"] input');
      await search.fill(prefix);
      const items = modal.locator('.asset-item');

      let count = 0;
      try {
        await items.first().waitFor({ state: 'visible', timeout: 5000 });
        count = await items.count();
      } catch {
        count = 0; // 无可清理素材（如用例在上传前已失败）
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

  test('E2E-101 上传单张图片后在网格中正常可见', async ({ page }) => {
    const prefix = `e2eimg${Date.now().toString(36)}`;
    uploadedPrefixes.push(prefix);
    await openMediaLibrary(page);

    // 相对断言：上传后「图片」计数 +1（规避账号内残留素材干扰）
    const countBefore = await imageTypeCount(page);
    const name = `${prefix}-1.png`;
    await uploadPngs(page, [
      { name, buffer: makeSolidPng(120, 90, [220, 60, 60]) },
    ]);
    await expect.poll(() => imageTypeCount(page), {
      timeout: 10000,
      message: '上传后「图片」类型计数应 +1',
    }).toBe(countBefore + 1);

    await expectAllImagesDecoded(assetItemByName(page, name), 1);
  });

  test('E2E-102 批量上传 3 张图片全部可见', async ({ page }) => {
    const prefix = `e2eimg${Date.now().toString(36)}`;
    uploadedPrefixes.push(prefix);
    await openMediaLibrary(page);

    const colors: [number, number, number][] = [
      [220, 60, 60],
      [60, 140, 220],
      [80, 190, 100],
    ];
    const files = colors.map((rgb, i) => ({
      name: `${prefix}-${i + 1}.png`,
      buffer: makeSolidPng(120 + i * 10, 100, rgb),
    }));
    await uploadPngs(page, files);

    // 搜索过滤到本用例素材，断言 3 张全部解码成功
    const search = page.locator('[data-track="grid_search_input"] input');
    await search.fill(prefix);
    const items = page.locator('.winbox-media-library .asset-item');
    await expectAllImagesDecoded(items, 3);
  });

  test('E2E-103 双击图片预览大图加载成功并可关闭', async ({ page }) => {
    const prefix = `e2eimg${Date.now().toString(36)}`;
    uploadedPrefixes.push(prefix);
    await openMediaLibrary(page);

    const name = `${prefix}-1.png`;
    await uploadPngs(page, [
      { name, buffer: makeSolidPng(320, 240, [150, 80, 200]) },
    ]);

    // 双击缩略图上部（避开右下角「插入到画布」按钮）
    const item = assetItemByName(page, name);
    await item.locator('.asset-item__thumbnail').dblclick({
      position: { x: 60, y: 20 },
    });

    const viewer = page.locator('.unified-viewer');
    await expect(viewer).toBeVisible({ timeout: 8000 });
    const previewImg = viewer.locator('img.media-viewport__image');
    await expect(previewImg).toBeVisible({ timeout: 10000 });
    await expect
      .poll(
        () =>
          previewImg.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 15000, message: '预览大图未成功解码' }
      )
      .toBeGreaterThan(0);

    await viewer.locator('.viewer-toolbar__btn--close').first().click();
    await expect(viewer).toBeHidden({ timeout: 5000 });
    // 关闭后回到网格，图片仍正常
    await expectAllImagesDecoded(assetItemByName(page, name), 1);
  });

  test('E2E-104 刷新页面后图片持久化仍可见', async ({ page }) => {
    const prefix = `e2eimg${Date.now().toString(36)}`;
    uploadedPrefixes.push(prefix);
    await openMediaLibrary(page);

    const name = `${prefix}-1.png`;
    await uploadPngs(page, [
      { name, buffer: makeSolidPng(160, 160, [230, 160, 40]) },
    ]);
    await expectAllImagesDecoded(assetItemByName(page, name), 1);

    // 刷新后重新打开素材库，验证 IndexedDB 元数据 + SW 缓存回放
    await page.reload();
    await openMediaLibrary(page, { goto: false });

    const item = assetItemByName(page, name);
    await expect(item).toBeVisible({ timeout: 15000 });
    await expectAllImagesDecoded(item, 1);
  });

  test('E2E-105 紧凑/列表视图切换后图片仍可见', async ({ page }) => {
    const prefix = `e2eimg${Date.now().toString(36)}`;
    uploadedPrefixes.push(prefix);
    await openMediaLibrary(page);

    const files = [1, 2].map((i) => ({
      name: `${prefix}-${i}.png`,
      buffer: makeSolidPng(
        100,
        100,
        i === 1 ? [70, 130, 180] : [180, 100, 60]
      ),
    }));
    await uploadPngs(page, files);

    // 搜索过滤到本用例素材，规避残留干扰
    const search = page.locator('[data-track="grid_search_input"] input');
    await search.fill(prefix);
    const items = page.locator('.winbox-media-library .asset-item');

    // 网格（默认）
    await expectAllImagesDecoded(items, 2);

    // 紧凑视图
    await page.locator('[data-track="view_mode_compact"]').click();
    await expect(items).toHaveCount(2);
    await expectAllImagesDecoded(items, 2);

    // 列表视图（名称展示区为 .asset-item__name）
    await page.locator('[data-track="view_mode_list"]').click();
    await expect(items).toHaveCount(2);
    for (const f of files) {
      await expect(
        items.filter({
          has: page.locator('.asset-item__name', { hasText: f.name }),
        })
      ).toHaveCount(1);
    }
    await expectAllImagesDecoded(items, 2);
  });

  test('E2E-106 非安全上下文（无 SW/Cache API）下上传图片仍可见', async ({
    page,
  }) => {
    // 模拟纯 HTTP 内网部署环境（如 8089 预览/8088 生产）：浏览器不暴露
    // Service Worker 与 Cache Storage API。此前 RetryImage 的虚拟路径判断
    // 只认 '/' 开头的相对路径，被 useThumbnailUrl 转成绝对 URL 后判断失效，
    // 降级链不触发，<img> 直接 404 —— 本用例锁定该回归。
    await page.addInitScript(() => {
      const navProto = Object.getPrototypeOf(navigator) as Record<
        string,
        unknown
      >;
      // 优先真删除（与真实非安全上下文一致：'serviceWorker' in navigator 为 false）
      try {
        delete navProto.serviceWorker;
      } catch {
        /* ignore */
      }
      if ('serviceWorker' in navigator) {
        try {
          Object.defineProperty(navigator, 'serviceWorker', {
            get: () => undefined,
            configurable: true,
          });
        } catch {
          /* ignore */
        }
      }
      try {
        delete (window as unknown as Record<string, unknown>).caches;
      } catch {
        /* ignore */
      }
      try {
        delete (Object.getPrototypeOf(window) as Record<string, unknown>)
          .caches;
      } catch {
        /* ignore */
      }
      if ('caches' in window) {
        try {
          Object.defineProperty(window, 'caches', {
            get: () => undefined,
            configurable: true,
          });
        } catch {
          /* ignore */
        }
      }
    });

    await openMediaLibrary(page);

    // 模拟生效性自检：SW 与 Cache API 必须都不存在，否则跳过（防假阳性）
    const sim = await page.evaluate(() => ({
      noSW: !('serviceWorker' in navigator),
      noCaches: !('caches' in window),
    }));
    test.skip(
      !(sim.noSW && sim.noCaches),
      `当前 Chromium 无法删除 SW/Cache API（noSW=${sim.noSW}, noCaches=${sim.noCaches}），无法模拟非安全上下文`
    );

    const prefix = `e2eimg${Date.now().toString(36)}`;
    uploadedPrefixes.push(prefix);
    const name = `${prefix}-1.png`;
    await uploadPngs(page, [
      { name, buffer: makeSolidPng(120, 90, [90, 90, 220]) },
    ]);
    await expectAllImagesDecoded(assetItemByName(page, name), 1);
  });
});

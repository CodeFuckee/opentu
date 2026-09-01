/**
 * 云端同步：画布素材（图片/文字/形状/笔画）跨设备同步 E2E 测试（@functional）
 *
 * 核心场景：设备 A 的画板放入四种素材（本地图片 / 文本 / 矩形 / 自由画笔迹）
 * → 立即同步 → 设备 B（全新无痕浏览器）同步后打开画板：
 * 1. 云端数据校验：user_sync_data 中该画板的 elements 四类齐全、内容一致；
 * 2. 设备 B 渲染校验：画布出现全部元素、文本内容可见；
 * 3. 设备 B 本地存储校验：IndexedDB（aitu-workspace/boards）还原的画板
 *    数据与设备 A 一致（下载应用无损）。
 *
 * 运行：npx playwright test --project=functional src/functional/cloud-sync-canvas-materials.spec.ts
 */
import {
  test,
  expect,
} from '../fixtures/test-base';
import type { Page } from '@playwright/test';
import { resolve as resolvePath } from 'path';
import { ensureE2EAccountRegistered } from '../fixtures/e2e-auth';
import { getTestAccount } from '../config/e2e.config';
import {
  clickToolRadio,
  dismissInspirationBoard,
  drawRectangle,
  expectElementsCreated,
  focusCanvasEmptyArea,
  pressToolKey,
} from '../fixtures/canvas-helpers';
import {
  classifyBoardElements,
  clickSyncNow,
  closeSyncSettingsDialog,
  createNamedBoard,
  extractSlateText,
  fetchRemoteBoardContent,
  forceFileInputFallback,
  insertImageToCanvas,
  loginViaUi,
  openCloudSyncSettings,
  openProjectDrawer,
  randomBoardName,
  syncAndOpenBoard,
  type BoardElementClassification,
} from '../fixtures/cloud-sync-helpers';

/** 同步后的文本内容（设备 A 输入 → 设备 B 校验一致） */
const SYNC_TEXT = 'E2E 云同步文字素材';

/** 画布元素数（plait-data-id 节点数） */
async function canvasElementCount(page: Page): Promise<number> {
  return page.locator('.board-host-svg .element-host [plait-data-id]').count();
}

/** 插入一段文本（点击画布左上空白处创建文本输入，输入后点击远处提交） */
async function insertText(page: Page, text: string): Promise<void> {
  const textRadio = page.getByRole('radio', { name: /文本/ }).first();
  await clickToolRadio(page, textRadio);
  await page.waitForTimeout(400);

  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const startX = vp.width / 2 - 320;
  const startY = vp.height / 2 - 160;
  await page.mouse.click(startX, startY);
  await page.waitForTimeout(500);
  await page.keyboard.type(text);
  // 提交：点击远处空白
  await page.mouse.click(startX + 420, startY + 260);
  await page.waitForTimeout(600);

  await expect
    .poll(async () => canvasElementCount(page), { timeout: 8000, intervals: [200] })
    .toBeGreaterThan(0);
}

/** 绘制自由画笔迹（右下区域，避开中心元素） */
async function drawFreehand(page: Page): Promise<void> {
  await focusCanvasEmptyArea(page);
  await pressToolKey(page, 'p', 'feltTipPen');
  await page.waitForTimeout(300);

  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const cx = vp.width / 2 + 200;
  const cy = vp.height / 2 + 120;
  await page.mouse.move(cx - 80, cy - 60);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 20, { steps: 6 });
  await page.mouse.move(cx + 40, cy + 40, { steps: 6 });
  await page.mouse.move(cx - 30, cy + 70, { steps: 6 });
  await page.mouse.up();
  await expectElementsCreated(page);
}

/**
 * 从设备页面 IndexedDB（aitu-workspace/boards）读取画板数据。
 * 直接验证「云端数据 → 本地存储」的还原无损（绕过 UI 渲染）。
 */
async function readBoardFromIndexedDB(
  page: Page,
  boardName: string
): Promise<{ elements: unknown[]; name: string } | null> {
  return page.evaluate(async (name) => {
    const DB_NAME = 'aitu-workspace';
    const STORE_NAME = 'boards';
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const all = await new Promise<Array<Record<string, unknown>>>(
        (resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).getAll();
          req.onsuccess = () => resolve((req.result ?? []) as Array<Record<string, unknown>>);
          req.onerror = () => reject(req.error);
        }
      );
      const board = all.find((b) => (b as { name?: string }).name === name);
      return board
        ? { elements: (board.elements ?? []) as unknown[], name: (board as { name: string }).name }
        : null;
    } finally {
      db.close();
    }
  }, boardName);
}

/** 断言四类素材的分类结果（图片/文本/形状/笔画各至少一个 + 文本内容一致） */
function expectFourMaterialTypes(
  classification: BoardElementClassification,
  context: string
): void {
  expect(classification.images.length, `${context}：图片素材`).toBeGreaterThanOrEqual(1);
  expect(classification.texts.length, `${context}：文字素材`).toBeGreaterThanOrEqual(1);
  expect(classification.shapes.length, `${context}：形状素材`).toBeGreaterThanOrEqual(1);
  expect(classification.freehands.length, `${context}：笔画素材`).toBeGreaterThanOrEqual(1);
  // 文本内容一致（设备 A 输入的文字原样到达设备 B / 云端）
  const textContent = classification.texts
    .map((t) => extractSlateText(t.text))
    .join('|');
  expect(textContent, `${context}：文本内容`).toContain(SYNC_TEXT);
}

test.describe('云端同步（画布素材跨设备）', () => {
  test('设备A画板 图片+文字+矩形+笔画 同步后，设备B完整还原', async ({ browser }, testInfo) => {
    test.setTimeout(360000);

    const boardName = randomBoardName();
    test.info().annotations.push({
      type: 'board-name',
      description: boardName,
    });

    // 统一配置的固定测试账号（按 worker 分配，不新建用户）
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    // ============ 设备 A：构建素材画板并同步 ============
    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await forceFileInputFallback(pageA);
    await loginViaUi(pageA, account.id);

    await openProjectDrawer(pageA);
    await createNamedBoard(pageA, boardName);
    await pageA.keyboard.press('Escape');
    await pageA.waitForTimeout(400);
    await dismissInspirationBoard(pageA);

    // 1) 文本素材（左上）→ 2) 图片素材（文件选择）→ 3) 矩形（中心）→ 4) 笔画（右下）
    await insertText(pageA, SYNC_TEXT);
    const testImagePath = resolvePath(
      __dirname,
      'fixtures',
      'test-image.png'
    );
    await insertImageToCanvas(pageA, testImagePath);
    await drawRectangle(pageA);
    await drawFreehand(pageA);

    // 画布上应有 ≥4 个元素（图片/文本/矩形/笔画）
    expect(
      await canvasElementCount(pageA),
      `设备 A 画布应包含 4 类素材，实际元素数`
    ).toBeGreaterThanOrEqual(4);

    // 立即同步
    await openCloudSyncSettings(pageA);
    await clickSyncNow(pageA);

    // 云端数据校验：四类素材齐全 + 文本内容一致 + 图片 URL 保真
    const remote = await fetchRemoteBoardContent(pageA, boardName);
    expect(remote, `云端应存在画板「${boardName}」的 board 记录`).not.toBeNull();
    const remoteClassification = classifyBoardElements(
      remote!.content.elements as unknown[]
    );
    expectFourMaterialTypes(remoteClassification, '云端数据');
    expect(
      remoteClassification.images[0].url as string,
      '云端图片素材 URL 应保持虚拟路径（/asset-library/ 前缀）'
    ).toMatch(/^\/asset-library\//);

    await contextA.close();

    // ============ 设备 B：同步并验证素材完整还原 ============
    const contextB = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageB = await contextB.newPage();
    await forceFileInputFallback(pageB);
    await loginViaUi(pageB, account.id);

    await openCloudSyncSettings(pageB);
    await clickSyncNow(pageB);
    await closeSyncSettingsDialog(pageB);

    // 设备 B：同步（含一次自动重试）并打开同步来的画板
    await syncAndOpenBoard(pageB, boardName);
    await dismissInspirationBoard(pageB);

    // 1) 渲染校验：四类素材元素都出现在画布上
    await expect
      .poll(() => canvasElementCount(pageB), {
        timeout: 20000,
        intervals: [300],
      })
      .toBeGreaterThanOrEqual(4);
    // 文本内容在画布渲染出来（Slate foreignObject 内）
    await expect(
      pageB.locator('.board-host-svg').getByText(SYNC_TEXT).first()
    ).toBeVisible({ timeout: 10000 });

    // 2) 本地存储校验：IndexedDB 还原的画板数据含四类素材且文本一致
    const restored = await readBoardFromIndexedDB(pageB, boardName);
    expect(restored, `设备 B 本地 IndexedDB 应包含画板「${boardName}」`).not.toBeNull();
    expectFourMaterialTypes(classifyBoardElements(restored!.elements), '设备B本地还原数据');

    await contextB.close();
  });

  test('增量同步：设备A新增素材再次同步后，设备B能拿到新增素材', async ({ browser }, testInfo) => {
    test.setTimeout(360000);

    const boardName = randomBoardName();
    test.info().annotations.push({
      type: 'board-name',
      description: boardName,
    });

    // 统一配置的固定测试账号（按 worker 分配，不新建用户）
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    // ============ 设备 A：先创建 文本 + 矩形 画板并同步 ============
    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await forceFileInputFallback(pageA);
    await loginViaUi(pageA, account.id);

    await openProjectDrawer(pageA);
    await createNamedBoard(pageA, boardName);
    await pageA.keyboard.press('Escape');
    await pageA.waitForTimeout(400);
    await dismissInspirationBoard(pageA);

    await insertText(pageA, SYNC_TEXT);
    await drawRectangle(pageA);

    await openCloudSyncSettings(pageA);
    await clickSyncNow(pageA);
    await closeSyncSettingsDialog(pageA);

    // 设备 A 再次新增素材：图片（第一轮同步后新增）
    await dismissInspirationBoard(pageA);
    const testImagePath = resolvePath(
      __dirname,
      'fixtures',
      'test-image.png'
    );
    await insertImageToCanvas(pageA, testImagePath);

    // 第二次同步（增量上传图片素材）
    await openCloudSyncSettings(pageA);
    await clickSyncNow(pageA);

    const remote = await fetchRemoteBoardContent(pageA, boardName);
    expect(remote, `云端应存在画板「${boardName}」`).not.toBeNull();
    const remoteClassification = classifyBoardElements(
      remote!.content.elements as unknown[]
    );
    // 云端已含 文本 + 矩形 + 图片 三类（增量没有丢第一轮的素材）
    expect(remoteClassification.total, '云端元素总数（增量后）').toBeGreaterThanOrEqual(3);
    expect(remoteClassification.texts.length, '增量后云端文字素材').toBe(1);
    expect(remoteClassification.shapes.length, '增量后云端形状素材').toBe(1);
    expect(remoteClassification.images.length, '增量后云端图片素材').toBe(1);

    await contextA.close();

    // ============ 设备 B：一次同步拉取全部（含增量素材） ============
    const contextB = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageB = await contextB.newPage();
    await forceFileInputFallback(pageB);
    await loginViaUi(pageB, account.id);
    // 设备 B：同步（含一次自动重试）并打开同步来的画板
    await syncAndOpenBoard(pageB, boardName);
    await dismissInspirationBoard(pageB);

    // 渲染校验：文本可见 + 元素数 ≥ 3（文本/矩形/图片）
    await expect
      .poll(() => canvasElementCount(pageB), {
        timeout: 20000,
        intervals: [300],
      })
      .toBeGreaterThanOrEqual(3);
    await expect(
      pageB.locator('.board-host-svg').getByText(SYNC_TEXT).first()
    ).toBeVisible({ timeout: 10000 });

    // 本地存储校验：三类素材齐全
    const restored = await readBoardFromIndexedDB(pageB, boardName);
    expect(restored, `设备 B 本地 IndexedDB 应包含画板「${boardName}」`).not.toBeNull();
    const localClassification = classifyBoardElements(restored!.elements);
    expect(localClassification.texts.length, '设备B本地文字素材').toBe(1);
    expect(localClassification.shapes.length, '设备B本地形状素材').toBe(1);
    expect(localClassification.images.length, '设备B本地图片素材').toBe(1);

    await contextB.close();
  });
});
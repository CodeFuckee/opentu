/**
 * 云端唯一存储 E2E（openspec remove-local-persistence，flag cloud_only_storage=1）
 *
 * 覆盖 tasks 5.2 核心场景（全部用例经 addInitScript 开启 flag；账号池复用，
 * 画板名称唯一不污染其他 spec）：
 * 1. 冷启动直拉：设备 B 全新登录，画板树不经任何手动同步直接来自云端；
 * 2. 整板 LWW＋CAS：两设备并发编辑同一画板，后落云者被乐观锁拒绝并提示；
 * 3. 断网「未同步」→ 恢复在线自动重试落云。
 *
 * 已知 quirk：plait 画布新建后的首次拖拽可能被异步渲染吞掉（元素延迟出现），
 * 绘制统一走 drawRectangleReliable（轮询元素增量 + 自动重画）。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  loginViaUi,
  openProjectDrawer,
  createNamedBoard,
  randomBoardName,
  verifyBoardInSupabase,
  fetchRemoteBoardByElementId,
  touchBoardRemotely,
  enableCloudOnlyStorage,
  disableCloudRealtime,
} from '../fixtures/cloud-sync-helpers';
import {
  focusCanvasEmptyArea,
  pressToolKey,
  screenAt,
} from '../fixtures/canvas-helpers';
import { ensureE2EAccountRegistered, getTestAccount } from '../fixtures/e2e-auth';

const CONFLICT_TOAST = /画板已在其他窗口\/设备修改，自动保存已暂停/;
const QUEUED_TOAST = /内容尚未同步到云端/;
const SYNCED_TOAST = /内容已同步到云端/;

/** 断言页面出现匹配的消息提示（Md3 消息宿主，warning 时长 8s，宽轮询窗口内必现） */
async function expectToast(page: Page, pattern: RegExp): Promise<void> {
  await expect(
    page
      .locator('.md3-message-host')
      .getByText(pattern)
      .first()
  ).toBeVisible({ timeout: 20_000 });
}

async function elementCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('.element-host [plait-data-id]').length
  );
}

/** 可靠绘制：拖拽后轮询元素增量，未出现则重画（首拖可能被异步渲染吞掉） */
async function drawRectangleReliable(
  page: Page,
  prevCount: number
): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await focusCanvasEmptyArea(page);
    await pressToolKey(page, 'r', 'rectangle');
    // 每次拖拽位置错开，避免重画时与上一元素完全重叠
    const offset = attempt * 30;
    const { x: x1, y: y1 } = screenAt(page, -80 + offset, -40 + offset);
    const { x: x2, y: y2 } = screenAt(page, 80 + offset, 40 + offset);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 6 });
    await page.mouse.up();

    try {
      await expect
        .poll(() => elementCount(page), {
          timeout: 15_000,
          intervals: [500],
        })
        .toBeGreaterThan(prevCount);
      return await elementCount(page);
    } catch {
      // 首拖被吞：循环重画
    }
  }
  throw new Error(`绘制矩形失败（重试 3 次后元素数仍为 ${await elementCount(page)}）`);
}

/** 取画布最后一个元素 id（plait-data-id），供云端按元素定位画板 */
async function getLastElementId(page: Page): Promise<string> {
  const id = await page
    .locator('.board-host-svg .element-host [plait-data-id]')
    .last()
    .getAttribute('plait-data-id');
  if (!id) {
    throw new Error('画布元素 plait-data-id 缺失');
  }
  return id;
}

test.describe('云端唯一存储（cloud_only_storage）', () => {
  test('冷启动直拉：设备A云端写画板，设备B全新登录免手动同步可见', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(600_000);

    const boardName = randomBoardName();
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    // ============ 设备 A：flag ON 登录 → 新建画板 → 直写云端 ============
    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await enableCloudOnlyStorage(pageA);
    await loginViaUi(pageA, account.id);

    await openProjectDrawer(pageA);
    await createNamedBoard(pageA, boardName);
    await pageA.waitForTimeout(2_500); // 等防抖保存落云

    const { found } = await verifyBoardInSupabase(pageA, boardName);
    expect(found).toBe(true);

    // ============ 设备 B：全新 context（无本地数据）→ 登录即见 ============
    // 关键断言：全程不点「立即同步」——画板树由冷启动云端直拉
    const contextB = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageB = await contextB.newPage();
    await enableCloudOnlyStorage(pageB);
    await loginViaUi(pageB, account.id);

    await openProjectDrawer(pageB);
    await expect(
      pageB
        .getByTestId('project-drawer')
        .getByText(boardName, { exact: true })
        .first()
    ).toBeVisible({ timeout: 30_000 });

    await contextA.close();
    await contextB.close();
  });

  test('双设备并发编辑同一画板：后落云者被 CAS 拒绝并提示', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(600_000);

    const boardName = randomBoardName();
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    // ============ 设备 A：创建画板、预热绘制并落云（禁用 Realtime，模拟
    // 「打开后对远端变更无感知」的另一设备并发编辑）============
    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await enableCloudOnlyStorage(pageA);
    await disableCloudRealtime(pageA);
    await loginViaUi(pageA, account.id);

    await openProjectDrawer(pageA);
    await createNamedBoard(pageA, boardName);
    await drawRectangleReliable(pageA, 0);
    await pageA.waitForTimeout(2_500); // 等预热编辑落云（基线 = 当前云端行）

    // ============ 「另一设备」修改画板（REST 直接改行 checksum＋updated_at）============
    // content 不变、checksum/updated_at 变化 → 等价于他端真实编辑：A 的 CAS 基线
    // 过期，且伪冲突自愈的 checksum 比对判定「内容已被他人修改」→ 真冲突
    await touchBoardRemotely(pageA, boardName);

    // ============ A 在陈旧基线上编辑保存 → CAS 拒绝 + 提示 ============
    // 冲突 toast 生命周期 8s，可能与元素渲染并行出现——先挂 toast 等待再绘制
    const consoleLogs: string[] = [];
    pageA.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' || text.includes('云端') || text.includes('[App]') || text.includes('[SupabaseSync]')) {
        consoleLogs.push(`[${msg.type()}] ${text.slice(0, 240)}`);
      }
    });
    const prevCount = await elementCount(pageA);
    const toastA = pageA
      .locator('.md3-message-host')
      .getByText(CONFLICT_TOAST)
      .first();
    const toastWait = expect(toastA).toBeVisible({ timeout: 30_000 });
    await drawRectangleReliable(pageA, prevCount);
    try {
      await toastWait;
    } catch (error) {
      const diag = `A_ELEMENTS: ${await elementCount(pageA)} | CONSOLE: ${consoleLogs.join(' || ') || '(none)'}`;
      throw new Error(`${(error as Error).message}\nDIAG2: ${diag}`);
    }

    await contextA.close();
  });

  test('断网编辑提示未同步，恢复在线自动重试落云', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(600_000);

    const boardName = randomBoardName();
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await enableCloudOnlyStorage(pageA);
    await loginViaUi(pageA, account.id);

    await openProjectDrawer(pageA);
    await createNamedBoard(pageA, boardName);
    // 预热绘制链路（在线）
    await drawRectangleReliable(pageA, 0);
    await pageA.waitForTimeout(2_500);

    // ============ 断网编辑：保存失败 → 内存保留＋「未同步」提示 ============
    await contextA.setOffline(true);
    const prevCount = await elementCount(pageA);
    await drawRectangleReliable(pageA, prevCount);
    const elementId = await getLastElementId(pageA);
    await expectToast(pageA, QUEUED_TOAST);

    // ============ 恢复在线：重试成功 → 「已同步」提示 + 云端可见该元素 ============
    await contextA.setOffline(false);
    await expectToast(pageA, SYNCED_TOAST);

    await expect
      .poll(async () => {
        const remote = await fetchRemoteBoardByElementId(pageA, elementId);
        return remote ? 1 : 0;
      }, { timeout: 30_000, intervals: [2_000] })
      .toBe(1);

    await contextA.close();
  });
});

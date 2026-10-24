/**
 * 跨设备自动同步（默认路径，flag 关）：零手动同步
 *
 * 用户场景（openspec remove-local-persistence 验收基线）：设备 A（Chrome）新建
 * 画布并改名 → 设备 B（Firefox）全新登录 → 直接可见且名称一致。
 *
 * 与 cloud-sync-delete-recreate（手动「立即同步」兜底）不同，本用例全程不点
 * 同步按钮——验证「事件驱动推送 + 登录拉取」的自动链路：
 * - A：createBoard/renameBoard → boardCreated/boardUpdated 事件 → ChangeBus →
 *   SyncPusher（3s 防抖）自动上云；
 * - B：登录 reconcile（waitForFirstReconcile）自动拉取云端画板树。
 * flag 开启（cloud_only_storage）路径由 cloud-only-storage.spec.ts 覆盖。
 */
import { test, expect } from '@playwright/test';
import {
  loginViaUi,
  openProjectDrawer,
  createNamedBoard,
  randomBoardName,
  verifyBoardInSupabase,
} from '../fixtures/cloud-sync-helpers';
import { ensureE2EAccountRegistered, getTestAccount } from '../fixtures/e2e-auth';

test.describe('跨设备自动同步（默认路径，零手动同步）', () => {
  test('设备A新建改名后，设备B全新登录直接可见且名称一致', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(600_000);

    const boardName = randomBoardName();
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    // ============ 设备 A（Chrome）：新建画板 + 改名 ============
    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await loginViaUi(pageA, account.id);

    await openProjectDrawer(pageA);
    await createNamedBoard(pageA, boardName);
    // 等事件驱动推送完成（SyncPusher 3s 防抖 + 网络）
    await pageA.waitForTimeout(8_000);

    // A 侧核验：画板已自动上云（RLS 本人可查）
    const { found } = await verifyBoardInSupabase(pageA, boardName);
    expect(found, 'A 的新建画板应在无手动同步的情况下自动上云').toBe(true);

    // ============ 设备 B（Firefox）：全新登录，零手动同步 ============
    const contextB = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageB = await contextB.newPage();
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
});

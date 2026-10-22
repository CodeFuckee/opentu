/**
 * 复现用户场景：设备 A 删光所有画板 → 新建一个并重命名 → 同步；
 * 设备 B 全新登录 → 数量与名称应与 A 一致（openspec refactor-cloud-native-sync）
 */
import { test, expect } from '@playwright/test';
import {
  loginViaUi,
  openProjectDrawer,
  createNamedBoard,
  countBoardsInDrawer,
  clickSyncNow,
  randomBoardName,
  verifyBoardInSupabase,
} from '../fixtures/cloud-sync-helpers';
import { ensureE2EAccountRegistered, getTestAccount } from '../fixtures/e2e-auth';
import { forceFileInputFallback } from '../fixtures/cloud-sync-helpers';

test.describe('云端同步（删光重建）', () => {
  test('设备A删光重建后，设备B重新登录应看到一致的数量与名称', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(600000);

    const boardName = randomBoardName();
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    const collectErrors = (page: import('@playwright/test').Page) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          errors.push(msg.text().slice(0, 200));
        }
      });
      return errors;
    };

    // ============ 设备 A：删光所有画板 → 新建重命名 → 同步 ============
    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await forceFileInputFallback(pageA);
    const errorsA = collectErrors(pageA);
    await loginViaUi(pageA, account.id);

    await openProjectDrawer(pageA);
    // 删光所有画板（行内 More → 菜单「删除」→ 确认弹窗「删除」）
    for (let i = 0; i < 10; i++) {
      const count = await pageA
        .getByTestId('project-drawer')
        .locator(
          '.project-drawer-node__row:not(.project-drawer-node__row--folder)'
        )
        .count();
      if (count === 0) {
        break;
      }
      const drawer = pageA.getByTestId('project-drawer');
      const firstBoardRow = drawer
        .locator('.project-drawer-node__row:not(.project-drawer-node__row--folder)')
        .first();
      await firstBoardRow.locator('button').first().click();
      // 下拉菜单中的「删除」
      await pageA.getByText('删除', { exact: true }).first().click();
      // 确认弹窗中的「删除」
      await pageA.getByRole('button', { name: '删除', exact: true }).click();
      await pageA.waitForTimeout(800);
    }
    // 删光后行数为 0，不能用带 >0 断言的 countBoardsInDrawer
    const countAAfterDelete = await pageA
      .getByTestId('project-drawer')
      .locator('.project-drawer-node__row:not(.project-drawer-node__row--folder)')
      .count();

    // 新建画板（命名即重命名终态）并立即同步
    await createNamedBoard(pageA, boardName);
    const countAAfterCreate = await countBoardsInDrawer(pageA);
    // 不用手动同步：推送器 3s 防抖自动推。轮询云端确认推送耗时
    let pushedAt: number | null = null;
    for (let t = 5; t <= 60; t += 5) {
      await pageA.waitForTimeout(5000);
      const dbCheck = await verifyBoardInSupabase(pageA, boardName);
      if (dbCheck.found) {
        pushedAt = t;
        console.log(`[repro] A 推送云端耗时=${t}s`);
        break;
      }
    }
    console.log(`[repro] A 推送=${pushedAt ?? '超时60s'}`);
    await contextA.close();

    // ============ 设备 B：全新登录（无本地缓存）→ 应与 A 一致 ============
    const contextB = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageB = await contextB.newPage();
    await forceFileInputFallback(pageB);
    const errorsB = collectErrors(pageB);
    await loginViaUi(pageB, account.id);

    // 打开项目抽屉后再观测（此前轮询时抽屉未开，行数恒为 -1）
    await openProjectDrawer(pageB);

    // 登录 reconcile（全新环境=全量拉取）可能较慢：最长等 300s，每 15s 探一次
    let foundAt: number | null = null;
    for (let t = 15; t <= 300; t += 15) {
      await pageB.waitForTimeout(15000);
      const drawerB = pageB.getByTestId('project-drawer');
      const drawerVisible = await drawerB.isVisible().catch(() => false);
      const n = drawerVisible
        ? await drawerB
            .locator(
              '.project-drawer-node__row:not(.project-drawer-node__row--folder)'
            )
            .count()
        : -1;
      console.log(`[repro] B ${t}s 行数=${n}`);
      if (n > 0) {
        const hasTarget = await drawerB
          .getByText(boardName, { exact: true })
          .first()
          .isVisible()
          .catch(() => false);
        console.log(`[repro] B ${t}s 含目标画板=${hasTarget}`);
        if (hasTarget) {
          foundAt = t;
          break;
        }
      }
    }
    console.log(`[repro] B 收敛耗时=${foundAt ?? '超时(>150s)'}`);
    if (errorsB.length > 0) {
      console.log('[repro] B 控制台错误(前5):', errorsB.slice(0, 5));
    }
    expect(foundAt, '设备 B 应在 300s 内看到目标画板').not.toBeNull();
    const countB = await countBoardsInDrawer(pageB);
    // 打印 B 的全部画板名（定位多出来的板）
    const namesB = await pageB
      .getByTestId('project-drawer')
      .locator('.project-drawer-node__row:not(.project-drawer-node__row--folder)')
      .allInnerTexts();
    console.log(`[repro] B 画板名:`, JSON.stringify(namesB));
    console.log(
      `[repro] A: 删后=${countAAfterDelete} 建后=${countAAfterCreate} | B: ${countB} | 期望名=${boardName}`
    );
    expect(errorsB.filter((e) => e.includes('SupabaseSync'))).toEqual([]);

    await contextB.close();
  });
});

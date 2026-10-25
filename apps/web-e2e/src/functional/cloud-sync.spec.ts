/**
 * 云端同步端到端测试（@functional）
 *
 * 场景：设备 A 新建画板（16 位随机名）+ 放入一张图片 → 云端同步 →
 * 设备 B（全新无痕浏览器）登录后同步 → 验证画板与图片都出现。
 *
 * 关键点（与共享 fixtures/cloud-sync-helpers 一致）：
 * 1. 两个独立 browserContext（无痕/incognito），模拟两台设备，本地存储互不共享；
 * 2. 同一测试账号在两个 context 中通过真实 UI 登录（复用 e2e-auth 注册）；
 * 3. 插入图片用 addImage（browser-fs-access 的 showOpenFilePicker）：
 *    通过 addInitScript 禁用 showOpenFilePicker 强制回退 <input type=file>，
 *    再用 filechooser/setInputFiles 提供本地测试图片；
 * 4. 数据库验证：用页面登录态 access_token 走 Supabase REST 查询 user_sync_data，
 *    确认画板记录已写入云端（RLS 允许用户查询自己的数据）；
 * 5. 设备 B 同步后：项目抽屉出现同名画板；打开画板后画布含图片元素。
 *
 * 运行：npx playwright test --project=functional src/functional/cloud-sync.spec.ts
 */
import { test, expect } from '../fixtures/test-base';
import { resolve as resolvePath } from 'path';
import { ensureE2EAccountRegistered } from '../fixtures/e2e-auth';
import { getTestAccount } from '../config/e2e.config';
import {
  clickSyncAction,
  clickSyncNow,
  disableCloudOnlyForLegacyPath,
  closeSyncSettingsDialog,
  countBoardsInDrawer,
  createNamedBoard,
  forceFileInputFallback,
  insertImageToCanvas,
  loginViaUi,
  openCloudSyncSettings,
  openProjectDrawer,
  randomBoardName,
  verifyBoardInSupabase,
} from '../fixtures/cloud-sync-helpers';

test.describe('云端同步（跨设备）', () => {
  test('设备A新建画板+图片同步后，设备B同步能看到', async ({ browser }, testInfo) => {
    // 全程包含两次登录 + 建画板 + 传图 + 同步 + 跨设备验证，需要较长超时
    test.setTimeout(300000);

    const boardName = randomBoardName();
    test.info().annotations.push({
      type: 'board-name',
      description: boardName,
    });

    // ============ 设备 A（context 1，无痕） ============
    // 统一配置的固定测试账号（按 worker 分配，不新建用户）
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    // 显式空 storageState：确保两个 context 都是「全新无痕设备」（不继承项目 auth 会话）
    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await disableCloudOnlyForLegacyPath(pageA);
    await forceFileInputFallback(pageA);
    await loginViaUi(pageA, account.id);

    // 1. 打开项目抽屉，新建画板（16 位随机名）
    await openProjectDrawer(pageA);
    await createNamedBoard(pageA, boardName);

    // 2. 在新画板中插入一张图片
    const testImagePath = resolvePath(
      __dirname,
      'fixtures',
      'test-image.png'
    );
    await insertImageToCanvas(pageA, testImagePath);

    // 3. 打开云端同步 → 立即同步
    await openCloudSyncSettings(pageA);
    await clickSyncNow(pageA);

    // 4. 验证 Supabase 数据库：user_sync_data 中有该画板（board）记录
    const dbCheck = await verifyBoardInSupabase(pageA, boardName);
    expect(
      dbCheck.found,
      `云端 user_sync_data 应包含画板「${boardName}」；收到 ${dbCheck.rows.length} 条 board 记录`
    ).toBe(true);

    // 5. 关闭设备 A（context 关闭 = 设备 A 本地数据消失，模拟真实换设备）
    await contextA.close();

    // ============ 设备 B（context 2，全新无痕） ============
    const contextB = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageB = await contextB.newPage();
    await disableCloudOnlyForLegacyPath(pageB);
    await forceFileInputFallback(pageB);
    await loginViaUi(pageB, account.id);

    // 6. 打开云端同步 → 立即同步（下载设备 A 的数据）
    await openCloudSyncSettings(pageB);
    await clickSyncNow(pageB);
    // 关闭同步设置对话框，避免遮挡项目抽屉
    await closeSyncSettingsDialog(pageB);

    // 7. 打开项目抽屉，验证画板出现
    await openProjectDrawer(pageB);
    const drawerB = pageB.getByTestId('project-drawer');
    await expect(
      drawerB.getByText(boardName, { exact: true }).first()
    ).toBeVisible({ timeout: 15000 });

    // 8. 打开该画板，验证图片元素存在
    await drawerB.getByText(boardName, { exact: true }).first().click();
    await pageB.waitForTimeout(1500);
    const elementCount = await pageB
      .locator('.board-host-svg .element-host [plait-data-id]')
      .count();
    expect(
      elementCount,
      `设备 B 打开画板「${boardName}」后画布应包含图片元素，实际 ${elementCount} 个`
    ).toBeGreaterThan(0);

    await contextB.close();
  });

  test('立即同步 / 下载远程 / 上传本地三操作画板数量一致（回归）', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(300000);

    const boardNameX = randomBoardName();
    const boardNameY = randomBoardName();

    // 统一配置的固定测试账号（按 worker 分配，不新建用户）
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    // ============ 设备 A：建 2 个画板 → 上传本地 ============
    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await disableCloudOnlyForLegacyPath(pageA);
    await forceFileInputFallback(pageA);
    await loginViaUi(pageA, account.id);

    await openProjectDrawer(pageA);
    await createNamedBoard(pageA, boardNameX);
    await createNamedBoard(pageA, boardNameY);
    // 关闭抽屉，避免遮挡菜单
    await pageA.keyboard.press('Escape');
    await pageA.waitForTimeout(300);

    // 上传本地（以本地为准）
    await openCloudSyncSettings(pageA);
    await clickSyncAction(pageA, '上传本地');
    await pageA.keyboard.press('Escape');
    await contextA.close();

    // ============ 设备 B：下载远程 → 应与云端一致（2 个画板） ============
    const contextB = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageB = await contextB.newPage();
    await disableCloudOnlyForLegacyPath(pageB);
    await forceFileInputFallback(pageB);
    await loginViaUi(pageB, account.id);

    // 先「下载远程」
    await openCloudSyncSettings(pageB);
    await clickSyncAction(pageB, '下载远程');
    await closeSyncSettingsDialog(pageB);

    await openProjectDrawer(pageB);
    // X 与 Y 都应出现（下载远程拉取完整云端数据）
    const drawerB = pageB.getByTestId('project-drawer');
    await expect(drawerB.getByText(boardNameX, { exact: true }).first()).toBeVisible({
      timeout: 15000,
    });
    await expect(drawerB.getByText(boardNameY, { exact: true }).first()).toBeVisible({
      timeout: 15000,
    });
    const countAfterPull = await countBoardsInDrawer(pageB);
    // 注意：设备 A 的默认画板「我的画板1」也会上传，故云端数量 = 默认板 + X + Y
    // 断言「下载远程」后 X/Y 出现，且数量 ≥ 2（不硬编码总数，避免默认画板命名差异）
    expect(
      countAfterPull >= 2,
      `下载远程后至少应含 X、Y 两个画板，实际 ${countAfterPull}`
    ).toBe(true);

    // 再「立即同步」→ 画板数量应与下载远程一致（回归：墓碑不复活 / 不丢画板）
    await pageB.keyboard.press('Escape');
    await pageB.waitForTimeout(300);
    await openCloudSyncSettings(pageB);
    await clickSyncAction(pageB, '立即同步');
    await closeSyncSettingsDialog(pageB);

    await openProjectDrawer(pageB);
    const countAfterSync = await countBoardsInDrawer(pageB);
    expect(
      countAfterSync,
      `立即同步后的画板数量应与下载远程一致（下载=${countAfterPull}，同步=${countAfterSync}）`
    ).toBe(countAfterPull);

    // 最后「上传本地」不影响画板数量
    await pageB.keyboard.press('Escape');
    await pageB.waitForTimeout(300);
    await openCloudSyncSettings(pageB);
    await clickSyncAction(pageB, '上传本地');
    await closeSyncSettingsDialog(pageB);

    await openProjectDrawer(pageB);
    const countAfterPush = await countBoardsInDrawer(pageB);
    expect(countAfterPush, `上传本地后画板数量不变，实际 ${countAfterPush}`).toBe(countAfterPull);

    await contextB.close();
  });
});
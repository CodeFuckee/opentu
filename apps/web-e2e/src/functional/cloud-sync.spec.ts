/**
 * 云端同步端到端测试（@functional）
 *
 * 场景：设备 A 新建画板（16 位随机名）+ 放入一张图片 → 云端同步 →
 * 设备 B（全新无痕浏览器）登录后同步 → 验证画板与图片都出现。
 *
 * 关键点：
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
import {
  createE2EAccount,
  ensureE2EAccountRegistered,
  getSupabaseConfig,
} from '../fixtures/e2e-auth';

/** 生成 16 位随机数（画板名称） */
function randomBoardName(): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** 强制 browser-fs-access 回退到 <input type=file>（Playwright 可拦截 filechooser） */
async function forceFileInputFallback(
  page: import('@playwright/test').Page
): Promise<void> {
  await page.addInitScript(() => {
    // 彻底删除原生 File System Access API，使 browser-fs-access 回退到 hidden input
    // （仅设为 undefined 不够：'showOpenFilePicker' in window 仍为 true，会走 FSA）
    try {
      delete window.showOpenFilePicker;
    } catch {
      // 某些浏览器该属性不可删除，改为覆盖为 undefined
      const w = window as unknown as Record<string, unknown>;
      w.showOpenFilePicker = undefined;
    }
  });
}

/** 通过真实 UI 登录（与 auth.setup 一致）；若已持有会话（storageState）则跳过 */
async function loginViaUi(
  page: import('@playwright/test').Page,
  account: string,
  password: string
): Promise<void> {
  await page.goto('/');
  // 可能已带 storageState 登录会话：等待「登录门禁」或「工作区」任一出现
  const gate = page.locator('[data-testid="auth-gate"]');
  const workspace = page.locator('.drawnix');
  await expect(gate.or(workspace).first()).toBeVisible({ timeout: 30000 });
  if (await gate.isVisible().catch(() => false)) {
    await page.getByPlaceholder('oa账号（小写）').fill(account);
    await page.getByPlaceholder('密码（至少 6 位）').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(workspace).toBeVisible({ timeout: 30000 });
  }
  // 等待工作区/工具栏完全就绪
  await expect(page.getByTestId('unified-toolbar')).toBeVisible({
    timeout: 15000,
  });
  await page.waitForTimeout(2500);
}

/** 打开项目抽屉（画布管理页签）；已打开则直接返回 */
async function openProjectDrawer(
  page: import('@playwright/test').Page
): Promise<void> {
  const drawer = page.getByTestId('project-drawer');
  if (await drawer.isVisible().catch(() => false)) {
    return;
  }
  const projectBtn = page.getByTestId('toolbar-project');
  await expect(projectBtn).toBeVisible({ timeout: 8000 });
  // 先清理可能残留的弹层/焦点，再点击；失败重试一次
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  await projectBtn.click({ force: true });
  try {
    await expect(drawer).toBeVisible({ timeout: 8000 });
  } catch {
    await projectBtn.click({ force: true });
    await expect(drawer).toBeVisible({ timeout: 8000 });
  }
}

/** 点击「新建画板」并重命名 */
async function createNamedBoard(
  page: import('@playwright/test').Page,
  name: string
): Promise<void> {
  const drawer = page.getByTestId('project-drawer');
  await drawer.getByRole('button', { name: '新建画板' }).click();
  // 新建后自动进入就地重命名态：节点内的 Input 自动聚焦
  // （注意：优先匹配画板节点内正在编辑的 input，避免匹配搜索框）
  const renameInput = drawer
    .locator('.project-drawer-node input')
    .first();
  await expect(renameInput).toBeVisible({ timeout: 5000 });
  await renameInput.fill(name);
  await renameInput.press('Enter');
  await page.waitForTimeout(500);
  // 确认画板出现在列表中
  await expect(drawer.getByText(name, { exact: true }).first()).toBeVisible({
    timeout: 5000,
  });
}

/** 通过工具栏的图片工具插入一张图片 */
async function insertImageToCanvas(
  page: import('@playwright/test').Page,
  imagePath: string
): Promise<void> {
  // 图片工具渲染为 radio（creation-toolbar，key='image'，点击后触发 addImage）
  const imageRadio = page.getByRole('radio', { name: /图片/ }).first();
  await expect(imageRadio).toBeVisible({ timeout: 8000 });

  // 监听 filechooser：addImage 会用隐藏 input 打开文件选择
  // 注意：TDesign radio 需点击 label（input 的直接父级）；不 force，让事件正常派发
  const radioLabel = imageRadio.locator('xpath=..');
  await radioLabel.scrollIntoViewIfNeeded();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    radioLabel.click(),
  ]);
  await chooser.setFiles(imagePath);

  // 等待图片元素渲染到画布（.element-host 中出现 plait-data-id 元素）
  await expect
    .poll(
      () =>
        page
          .locator('.board-host-svg .element-host [plait-data-id]')
          .count(),
      { timeout: 10000, intervals: [300] }
    )
    .toBeGreaterThan(0);
}

/** 打开云端同步设置面板 */
async function openCloudSyncSettings(
  page: import('@playwright/test').Page
): Promise<void> {
  // 打开 App 菜单
  const menuBtn = page.locator(
    '.unified-toolbar [data-track="toolbar_click_menu"]'
  );
  await expect(menuBtn).toBeVisible({ timeout: 8000 });
  await menuBtn.click({ force: true });
  // 点「云端同步」菜单项
  const cloudSyncItem = page.locator(
    '[data-track="toolbar_click_menu_cloud_sync"]'
  );
  await expect(cloudSyncItem).toBeVisible({ timeout: 5000 });
  await cloudSyncItem.click();

  const dialog = page.locator('.sync-settings-dialog');
  await expect(dialog).toBeVisible({ timeout: 8000 });
}

/** 点击「立即同步」并等待完成 */
async function clickSyncNow(
  page: import('@playwright/test').Page
): Promise<void> {
  const dialog = page.locator('.sync-settings-dialog');
  const syncBtn = dialog.getByRole('button', { name: /立即同步/ });
  await expect(syncBtn).toBeVisible({ timeout: 8000 });
  await syncBtn.click();
  // 等待同步中状态结束：按钮重新可用（文本恢复为「立即同步」，非「同步中...」）
  await expect(syncBtn).toBeEnabled({ timeout: 30000 });
  await page.waitForTimeout(1500);
}

/** 通过 Supabase REST 验证云端 user_sync_data 中存在画板记录 */
async function verifyBoardInSupabase(
  page: import('@playwright/test').Page,
  boardName: string
): Promise<{ found: boolean; rows: unknown[] }> {
  const { url, anonKey } = getSupabaseConfig();
  // 从页面 localStorage 取 access_token（supabase-js 默认 key：sb-{ref}-auth-token）
  const { accessToken } = await page.evaluate(() => {
    let token = '';
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        if (!key.startsWith('sb-') || !key.endsWith('-auth-token')) {
          continue;
        }
        const raw = localStorage.getItem(key) || '';
        const parsed = JSON.parse(raw);
        token =
          parsed?.currentSession?.access_token ||
          parsed?.access_token ||
          '';
        if (token) {
          break;
        }
      }
    } catch {
      // 解析失败则 token 为空
    }
    return { accessToken: token };
  });

  if (!accessToken) {
    return { found: false, rows: [] };
  }

  // 直接 REST 查询：entity_type='board' 的所有记录，本地过滤画板名
  const res = await fetch(
    `${url}/rest/v1/user_sync_data?select=entity_type,entity_id,content,checksum&entity_type=eq.board&order=updated_at.desc`,
    {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
  if (!res.ok) {
    return { found: false, rows: [] };
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  const found = rows.some((row) => {
    const content = row.content as Record<string, unknown> | null;
    return content?.name === boardName;
  });
  return { found, rows };
}

test.describe('云端同步（跨设备）', () => {
  test('设备A新建画板+图片同步后，设备B同步能看到', async ({ browser }) => {
    // 全程包含两次登录 + 建画板 + 传图 + 同步 + 跨设备验证，需要较长超时
    test.setTimeout(300000);

    const boardName = randomBoardName();
    test.info().annotations.push({
      type: 'board-name',
      description: boardName,
    });

    // ============ 设备 A（context 1，无痕） ============
    const { account, password } = createE2EAccount();
    await ensureE2EAccountRegistered(account, password);

    // 显式空 storageState：确保两个 context 都是「全新无痕设备」（不继承项目 auth 会话）
    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await forceFileInputFallback(pageA);
    await loginViaUi(pageA, account, password);

    // 1. 打开项目抽屉，新建画板（16 位随机名）
    await openProjectDrawer(pageA);
    await createNamedBoard(pageA, boardName);

    // 2. 在新画板中插入一张图片
    const testImagePath = require('path').resolve(
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
    await forceFileInputFallback(pageB);
    await loginViaUi(pageB, account, password);

    // 6. 打开云端同步 → 立即同步（下载设备 A 的数据）
    await openCloudSyncSettings(pageB);
    await clickSyncNow(pageB);
    // 关闭同步设置对话框，避免遮挡项目抽屉
    await pageB.keyboard.press('Escape');
    await pageB.waitForTimeout(500);

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
});
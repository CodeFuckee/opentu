/**
 * 项目抽屉测试（@functional）
 *
 * 覆盖：项目抽屉打开/关闭、标签（画布管理/PPT编辑/图层）、
 * 新建画板/新建目录/导入/导出入口、批量管理（多选/全选/批量删除）。
 */
import { test, expect } from '../fixtures/test-base';
import type { Page } from '@playwright/test';
import {
  disableCloudPullForLocalIsolation,
  openProjectDrawer,
  createNamedBoard,
} from '../fixtures/cloud-sync-helpers';
import {
  SUPABASE,
  E2E_TEST_PASSWORD,
  getDefaultTestAccount,
  accountEmail,
} from '../fixtures/e2e-auth';

/** 生成用例内唯一的画板名后缀，避免与共享数据/默认画板撞名 */
const uniqueSuffix = () => Date.now().toString(36);

/** 打开抽屉并创建若干唯一命名画板（最后创建的为当前画板） */
async function setupDrawerWithBoards(
  page: Page,
  names: string[]
): Promise<ReturnType<Page['getByTestId']>> {
  await page.goto('/');
  await expect(page.getByTestId('unified-toolbar')).toBeVisible({
    timeout: 15000,
  });
  await openProjectDrawer(page);
  for (const name of names) {
    await createNamedBoard(page, name);
  }
  return page.getByTestId('project-drawer');
}

test.describe('项目抽屉', () => {
  test('打开/关闭项目抽屉', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    const projectBtn = page.getByTestId('toolbar-project');
    await expect(projectBtn).toBeVisible();
    await projectBtn.click();

    // 抽屉出现 + 标题
    const drawer = page.getByTestId('project-drawer');
    await expect(drawer).toBeVisible({ timeout: 8000 });
    await expect(
      page.getByRole('heading', { name: '项目', exact: true })
    ).toBeVisible();

    // 标签页
    const tabCanvas = drawer.getByRole('button', { name: '画布管理' });
    await expect(tabCanvas).toBeVisible();
    const tabPpt = drawer.getByRole('button', { name: 'PPT 编辑' });
    await expect(tabPpt).toBeVisible();
    const tabLayer = drawer.getByRole('button', { name: '图层' });
    await expect(tabLayer).toBeVisible();

    // 新建画板 / 新建目录 / 导入 / 导出
    await expect(
      drawer.getByRole('button', { name: '新建画板' })
    ).toBeVisible();
    await expect(
      drawer.getByRole('button', { name: '新建目录' })
    ).toBeVisible();
    await expect(drawer.getByRole('button', { name: '导入' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '导出' })).toBeVisible();

    // 关闭（再次点击项目按钮）
    await projectBtn.click();
    await expect(drawer).toBeHidden({ timeout: 8000 });
  });

  test('切换到 PPT 编辑标签', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId('toolbar-project').click();
    const drawer = page.getByTestId('project-drawer');
    await expect(drawer).toBeVisible({ timeout: 8000 });

    const pptTab = drawer.getByRole('button', { name: 'PPT 编辑' });
    await pptTab.click();
    await page.waitForTimeout(600);
    // PPT 标签激活（选中态类名）
    await expect(pptTab).toHaveClass(/active|selected/i);

    await page.keyboard.press('Escape');
  });
});

test.describe('批量管理（多选/全选/批量删除）', () => {
  // 云端唯一存储默认开启后，共享账号池的云端历史画板会进视图——
  // 批量删除用例依赖可控的画板清单，统一接入本地隔离
  test.beforeEach(async ({ page }) => {
    await disableCloudPullForLocalIsolation(page);
  });

  // 本地隔离只关闭云端拉取，旧引擎的自动推送仍会把用例中新建/删除的画板
  // 推到共享账号池的云端，搅乱后续用例的云端状态恢复（auth-setup 首当其冲）。
  // 收尾统一清空该账号的画板与工作区状态，保持账号池对其他套件干净。
  test.afterAll(async ({ request }) => {
    const account = getDefaultTestAccount();
    const tokenRes = await request.post(
      `${SUPABASE.url}/auth/v1/token?grant_type=password`,
      {
        data: {
          email: accountEmail(account.id),
          password: E2E_TEST_PASSWORD,
        },
        headers: { apikey: SUPABASE.anonKey },
      }
    );
    const { access_token: accessToken } = (await tokenRes.json()) as {
      access_token?: string;
    };
    if (!accessToken) {
      throw new Error('afterAll 清理失败：未能获取测试账号 access_token');
    }
    for (const entityType of ['board', 'workspace_state']) {
      const res = await request.delete(
        `${SUPABASE.url}/rest/v1/user_sync_data?entity_type=eq.${entityType}`,
        {
          headers: {
            apikey: SUPABASE.anonKey,
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      if (!res.ok()) {
        throw new Error(
          `afterAll 清理失败：删除 ${entityType} 返回 HTTP ${res.status()}`
        );
      }
    }
  });

  test('P0：批量模式点击选中→全选→批量删除→自动退出', async ({ page }) => {
    const suffix = uniqueSuffix();
    const nameA = `批量甲${suffix}`;
    const nameB = `批量乙${suffix}`;
    const drawer = await setupDrawerWithBoards(page, [nameA, nameB]);

    // 进入批量模式：出现全选按钮，删除按钮在未选中时禁用
    // （禁用态 tdesign Button 渲染为带 t-is-disabled 类的 div，非表单控件，
    // Playwright 的 toBeDisabled 不识别，统一用类名断言）
    const batchBtn = drawer.getByTestId('project-drawer-batch-mode-btn');
    await batchBtn.click();
    const selectAllBtn = drawer.getByTestId('project-drawer-select-all-btn');
    const deleteBtn = drawer.getByTestId('project-drawer-batch-delete-btn');
    await expect(selectAllBtn).toBeVisible();
    await expect(selectAllBtn).toHaveText('全选');
    await expect(deleteBtn).toHaveClass(/t-is-disabled/);

    // 普通点击两个画板（无需 Ctrl/Shift）→ 已选择 2
    await drawer.getByText(nameA, { exact: true }).click();
    await expect(drawer.getByText('已选择 1 个画板')).toBeVisible();
    await drawer.getByText(nameB, { exact: true }).click();
    await expect(drawer.getByText('已选择 2 个画板')).toBeVisible();

    // 全选：覆盖过滤树中的全部画板（含默认画板，故 ≥2）
    await selectAllBtn.click();
    const total = await drawer.locator('.project-drawer-node__row').count();
    expect(total).toBeGreaterThanOrEqual(2);
    await expect(drawer.getByText(`已选择 ${total} 个画板`)).toBeVisible();

    // 批量删除全部选中
    await deleteBtn.click();
    const confirmDialog = page.locator('.confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText(
      `确定要删除选中的 ${total} 个画板吗`
    );
    await confirmDialog.getByRole('button', { name: '删除' }).click();
    // 自定义 MessagePlugin 可能渲染多份相同 toast DOM，取 first 规避严格模式冲突
    await expect(
      page.getByText(`成功删除 ${total} 个画板`).first()
    ).toBeVisible({ timeout: 5000 });

    // 删除成功后自动退出批量模式、选择清空
    await expect(batchBtn).toHaveText('批量管理');
    await expect(selectAllBtn).toBeHidden();
    // 清空后本地兜底可能自动补建默认画板，行数不超过 1 即视为删净
    const rowsAfter = await drawer.locator('.project-drawer-node__row').count();
    expect(rowsAfter).toBeLessThanOrEqual(1);
  });

  test('P1：批量模式普通点击不切换当前画板', async ({ page }) => {
    const suffix = uniqueSuffix();
    const nameA = `不切甲${suffix}`;
    const nameB = `不切乙${suffix}`;
    const drawer = await setupDrawerWithBoards(page, [nameA, nameB]);

    // 最后创建的 nameB 是当前画板
    const activeRow = drawer.locator('.project-drawer-node__row--active');
    await expect(activeRow).toContainText(nameB);

    await drawer.getByTestId('project-drawer-batch-mode-btn').click();
    // 批量模式下点击 nameA：仅选中，不切换当前画板
    await drawer.getByText(nameA, { exact: true }).click();
    await expect(drawer.getByText('已选择 1 个画板')).toBeVisible();
    await expect(activeRow).toContainText(nameB);
  });

  test('P1：取消全选清空选择，完成后恢复普通点击', async ({ page }) => {
    const suffix = uniqueSuffix();
    const nameA = `恢复甲${suffix}`;
    const nameB = `恢复乙${suffix}`;
    const drawer = await setupDrawerWithBoards(page, [nameA, nameB]);

    await drawer.getByTestId('project-drawer-batch-mode-btn').click();
    const selectAllBtn = drawer.getByTestId('project-drawer-select-all-btn');
    await selectAllBtn.click();
    await expect(selectAllBtn).toHaveText('取消全选');
    const total = await drawer.locator('.project-drawer-node__row').count();
    await expect(drawer.getByText(`已选择 ${total} 个画板`)).toBeVisible();

    // 取消全选：清空且删除禁用
    await selectAllBtn.click();
    await expect(drawer.getByText('已选择 0 个画板')).toBeVisible();
    await expect(
      drawer.getByTestId('project-drawer-batch-delete-btn')
    ).toHaveClass(/t-is-disabled/);

    // 完成：退出批量模式，全选按钮与选择条隐藏
    const batchBtn = drawer.getByTestId('project-drawer-batch-mode-btn');
    await expect(batchBtn).toHaveText('完成');
    await batchBtn.click();
    await expect(selectAllBtn).toBeHidden();
    await expect(drawer.getByText(/已选择 \d+ 个画板/)).toBeHidden();

    // 普通点击恢复切换画板语义（点击 nameA 后当前画板变化且无选择残留）
    await drawer.getByText(nameA, { exact: true }).click();
    await expect(drawer.locator('.project-drawer-node__row--active')).toContainText(
      nameA
    );
    await expect(drawer.getByText(/已选择 \d+ 个画板/)).toBeHidden();
  });

  test('P1：搜索过滤下全选只选命中画板', async ({ page }) => {
    const suffix = uniqueSuffix();
    const nameHit1 = `搜筛${suffix}甲`;
    const nameHit2 = `搜筛${suffix}乙`;
    const nameMiss = `无关板${suffix}`;
    const drawer = await setupDrawerWithBoards(page, [
      nameHit1,
      nameHit2,
      nameMiss,
    ]);

    await drawer.getByTestId('project-drawer-batch-mode-btn').click();
    // 搜索词只命中两个「搜筛」画板
    await drawer.getByPlaceholder('搜索...').fill(`搜筛${suffix}`);
    await drawer.getByTestId('project-drawer-select-all-btn').click();
    await expect(drawer.getByText('已选择 2 个画板')).toBeVisible();
  });

  test('回归：非批量模式下 Ctrl+点击多选仍可用', async ({ page }) => {
    const suffix = uniqueSuffix();
    const nameA = `回归甲${suffix}`;
    const nameB = `回归乙${suffix}`;
    const drawer = await setupDrawerWithBoards(page, [nameA, nameB]);

    // 不进入批量模式，Ctrl+点击两行仍可累计多选
    // （两次点击之间用中间断言拉开间隔：行点击有 200ms 双击判定定时器，
    // 间隔过近时后一次点击会取消前一次的待执行点击——与真实用户节奏一致）
    await drawer.getByText(nameA, { exact: true }).click({
      modifiers: ['Control'],
    });
    await expect(drawer.getByText('已选择 1 个画板')).toBeVisible();
    await drawer.getByText(nameB, { exact: true }).click({
      modifiers: ['Control'],
    });
    await expect(drawer.getByText('已选择 2 个画板')).toBeVisible();
  });
});
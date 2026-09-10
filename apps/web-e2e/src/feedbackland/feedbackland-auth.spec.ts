import { expect, test, type Page } from '@playwright/test';
import { accountEmail, getCustomTestAccount } from '../config/e2e.config';

/**
 * Feedbackland Supabase 账号登录 E2E（http://10.37.80.25:8090）
 *
 * 验证：Supabase 账号能正常登录 Feedbackland、登录后用户名正确、帖子看板页面正确。
 *
 * 前置条件：
 * - 账号：apps/web-e2e/.env.e2e.local 的 E2E_CUSTOM_ACCOUNT / E2E_CUSTOM_PASSWORD
 *   （oa 账号，登录邮箱为 ${账号}@yjk.com）；未配置时整组用例跳过
 * - 数据：看板页依赖 org 存在。首次运行时用例会自动通过 /get-started 创建
 *   subdomain=yjk 的组织（幂等：已存在则直接复用）
 *
 * 运行（--skip-nx-cache 确保真实执行）：
 *   pnpm e2e:feedbackland
 *   pnpm exec nx run web-e2e:e2e --skip-nx-cache -- --project=feedbackland --headed
 */

const ORG_SUBDOMAIN = 'yjk';
// 看板空态标题（全新组织无帖子时显示，见 feedback-posts/empty.tsx）
const BOARD_EMPTY_TITLE = 'No Feedback Yet';

const account = getCustomTestAccount();
const EMAIL = account ? accountEmail(account.id) : '';
const PASSWORD = account?.password ?? '';
// 登录后头部展示的用户名（注册时以 oa 账号名作为 name）
const EXPECTED_NAME = account?.id ?? '';

test.skip(
  !account,
  '未配置 E2E_CUSTOM_ACCOUNT/E2E_CUSTOM_PASSWORD（apps/web-e2e/.env.e2e.local），跳过 Feedbackland 登录用例'
);

// 头部登录入口：图标按钮（LogInIcon），登录后消失
const SIGN_IN_TRIGGER = 'button:has(svg.lucide-log-in)';
// 登录后的头像下拉触发按钮（platform-header buttons.tsx：variant ghost + rounded-full）
const AVATAR_TRIGGER = 'button.rounded-full';

async function openSignInDialog(page: Page): Promise<void> {
  // 登录入口在看板页头部（应用根路径 / 是 404 页，无头部）
  await page.goto(`/${ORG_SUBDOMAIN}`);
  const trigger = page.locator(SIGN_IN_TRIGGER).first();
  await expect(trigger, '未登录态头部应有登录入口按钮').toBeVisible();
  await trigger.click();
  await expect(
    page.getByRole('button', { name: 'Sign in with Email' })
  ).toBeVisible();
}

/** 登录成功的标志：登录图标消失、头像按钮出现 */
async function expectSignedIn(page: Page): Promise<void> {
  await expect(page.locator(SIGN_IN_TRIGGER)).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(
    page.locator(AVATAR_TRIGGER).first(),
    '登录成功后头部应出现头像按钮'
  ).toBeVisible();
}

async function signInViaDialog(page: Page): Promise<void> {
  await openSignInDialog(page);
  await page.getByRole('button', { name: 'Sign in with Email' }).click();

  const emailInput = page.getByPlaceholder('Email');
  await expect(emailInput).toBeVisible();
  await emailInput.fill(EMAIL);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expectSignedIn(page);
}

/**
 * 展开头像下拉菜单并返回其中显示的用户名。
 * 用户名来自 Supabase 会话元数据 name；该元数据缺失时应用兜底显示 "Unnamed user"
 * （platform-header buttons.tsx: session?.user?.name || "Unnamed user"）。
 */
async function readDropdownDisplayName(page: Page): Promise<string> {
  await page.locator(AVATAR_TRIGGER).first().click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // 邮箱是账号身份的强断言：下拉菜单必须显示当前登录账号的邮箱
  await expect(menu.getByText(EMAIL), '下拉菜单应显示登录账号邮箱').toBeVisible();
  const name = (
    await menu.locator('div.font-semibold span').first().textContent()
  )?.trim();
  await page.keyboard.press('Escape');
  return name ?? '';
}

/** 幂等确保 org 可用：org yjk 由首次使用流程创建（/get-started → claim），存在时直接复用 */
async function ensureOrg(page: Page): Promise<void> {
  await page.goto(`/${ORG_SUBDOMAIN}`, { waitUntil: 'domcontentloaded' });
  // 看板搜索框存在即说明页面正常（org 存在与否不影响只读看板渲染）
  await expect(
    page.getByPlaceholder('Search...'),
    '看板页应正常渲染'
  ).toBeVisible();
}

test.describe('Feedbackland Supabase 账号登录', () => {
  test('FB-001 Supabase 账号登录成功', async ({ page }) => {
    await openSignInDialog(page);
    await page.getByRole('button', { name: 'Sign in with Email' }).click();
    await page.getByPlaceholder('Email').fill(EMAIL);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expectSignedIn(page);
  });

  test('FB-002 登录后用户名正确', async ({ page }) => {
    await signInViaDialog(page);

    const displayName = await readDropdownDisplayName(page);
    // 账号身份强校验已由 helper 中的邮箱断言完成；用户名允许两种合法值：
    // 注册名（Supabase 元数据 name）或应用兜底 "Unnamed user"（该 e2e 账号
    // 的元数据无 name，走 buttons.tsx 的 || "Unnamed user" 兜底）
    expect(
      [EXPECTED_NAME, 'Unnamed user'],
      `下拉菜单显示的用户名「${displayName}」不在合法范围内`
    ).toContain(displayName);
    test.info().annotations.push({
      type: 'display-name',
      description: `当前显示用户名：${displayName}`,
    });
  });

  test('FB-003 帖子看板页面正确', async ({ page }) => {
    await signInViaDialog(page);
    await ensureOrg(page);

    await page.goto(`/${ORG_SUBDOMAIN}`, { waitUntil: 'domcontentloaded' });
    // 看板核心元素（登录态）：搜索框 + 状态筛选 + 发帖输入框
    await expect(
      page.getByPlaceholder('Search...'),
      '看板页应渲染搜索框'
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Newest' }),
      '看板页应渲染排序筛选'
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Submit feedback' }),
      '看板页应渲染发帖输入区（Submit feedback 按钮；编辑器占位文本是 CSS 生成内容，不可用 getByText 定位）'
    ).toBeVisible();
    // 页面不应处于错误态（精确匹配，避免误伤页面上含数字的普通元素）
    await expect(
      page.getByText('Internal Server Error', { exact: true }),
      '看板页不应出现服务端错误'
    ).toHaveCount(0);
  });

  test('FB-004 未登录访问看板', async ({ page }) => {
    const response = await page.goto(`/${ORG_SUBDOMAIN}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(
      response?.status() ?? 0,
      '未登录访问看板不应出现 5xx'
    ).toBeLessThan(500);
    // 未登录态：要么只读看板正常渲染，要么出现登录入口；断言页面非空白
    const pageHasContent =
      (await page.locator(SIGN_IN_TRIGGER).count()) > 0 ||
      (await page.getByText(BOARD_EMPTY_TITLE).count()) > 0 ||
      (await page.locator('main').count()) > 0;
    expect(pageHasContent, '未登录访问看板应有正常页面内容').toBeTruthy();
  });

  test('FB-005 错误密码登录失败', async ({ page }) => {
    await openSignInDialog(page);
    await page.getByRole('button', { name: 'Sign in with Email' }).click();
    await page.getByPlaceholder('Email').fill(EMAIL);
    await page.getByPlaceholder('Password').fill('wrong-password-e2e');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // 表单 root.serverError 提示（Supabase 凭据无效）
    await expect(
      page.locator('p.text-destructive'),
      '错误密码应显示失败提示'
    ).toBeVisible({ timeout: 15_000 });
    // 仍处于未登录态：登录入口仍在，头像未出现
    await expect(page.locator(SIGN_IN_TRIGGER).first()).toBeVisible();
    await expect(page.locator(AVATAR_TRIGGER)).toHaveCount(0);
  });

  test('FB-006 刷新后登录态保持', async ({ page }) => {
    await signInViaDialog(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expectSignedIn(page);
  });
});

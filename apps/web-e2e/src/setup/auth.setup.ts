/**
 * 认证 setup 项目
 *
 * 当前应用进入工作区前需要 Supabase 登录（AuthGate）。本 setup 项目：
 * 1. 通过 GoTrue REST API 确保统一配置的固定测试账号已注册（幂等，
 *    账号/密码统一在 src/config/e2e.config.ts，不再随机新建用户）；
 * 2. 打开应用，走真实 UI 登录表单（oa账号 + 密码）；
 * 3. 等待工作区（.drawnix）出现后，把会话保存为 storageState。
 *
 * 其它测试项目通过 `dependencies: ['setup']` + `use.storageState` 以已登录状态运行，
 * 避免每个测试都重复登录。
 *
 * 环境要求：Supabase 后端可达（配置见 src/config/e2e.config.ts 的 SUPABASE）。
 */
import { test as setup, expect } from '@playwright/test';
import {
  ensureE2EAccountRegistered,
  getDefaultTestAccount,
  E2E_TEST_PASSWORD,
} from '../fixtures/e2e-auth';
import { E2E_STATE_PATH } from '../config/e2e.config';

setup('以统一配置账号登录并保存会话', async ({ page }) => {
  const account = getDefaultTestAccount();
  await ensureE2EAccountRegistered(account);

  await page.goto('/');

  // 等待门禁出现（超过 30s 说明后端不可达，直接报错暴露环境问题）
  await expect(page.locator('[data-testid="auth-gate"]')).toBeVisible({
    timeout: 30000,
  });

  await page.getByPlaceholder('oa账号（小写）').fill(account.id);
  await page.getByPlaceholder('密码（至少 6 位）').fill(E2E_TEST_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();

  // 登录成功后 AuthGate 自动切换到工作区
  await expect(page.locator('.drawnix')).toBeVisible({ timeout: 30000 });

  await page.context().storageState({ path: E2E_STATE_PATH });
});
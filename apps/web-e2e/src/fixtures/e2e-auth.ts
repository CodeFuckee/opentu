/**
 * E2E 认证辅助模块
 *
 * 账号与环境的配置统一在 src/config/e2e.config.ts（本文件禁止再定义账号/环境常量）：
 * - 测试账号池：固定账号按 worker 分配，测试代码不得随机新建用户
 * - 统一密码：E2E_TEST_PASSWORD
 * - Supabase 环境：SUPABASE（URL / anon key）
 * - storageState 路径：E2E_STATE_PATH
 *
 * 本文件只保留两件事：
 * 1. 账号注册（GoTrue REST，幂等：已注册时忽略错误）；
 * 2. 按 workerIndex 取固定测试账号的入口。
 */
import {
  accountEmail,
  E2E_TEST_PASSWORD,
  getTestAccount,
  SUPABASE,
} from '../config/e2e.config';
import type { E2ETestAccount } from '../config/e2e.config';

// 统一配置的对外 re-export（测试与 fixtures 只从本模块或 config 引用）
export {
  accountEmail,
  E2E_TEST_PASSWORD,
  getTestAccount,
  getDefaultTestAccount,
  getCustomTestAccount,
  SUPABASE,
  TEST_ACCOUNTS,
  type E2ETestAccount,
} from '../config/e2e.config';
export { E2E_STATE_PATH } from '../config/e2e.config';

/**
 * 确保测试账号已注册（幂等）。
 * 只允许注册统一配置中的固定账号（TEST_ACCOUNTS）或自定义账号
 * （.env.e2e.local / 环境变量配置），禁止动态生成新账号。
 * 密码优先使用账号自带的 password（自定义账号），否则回退 E2E_TEST_PASSWORD。
 */
export async function ensureE2EAccountRegistered(
  account: E2ETestAccount | string
): Promise<boolean> {
  const accountId = typeof account === 'string' ? account : account.id;
  const email = accountEmail(accountId);
  const password =
    typeof account === 'string'
      ? E2E_TEST_PASSWORD
      : (account.password ?? E2E_TEST_PASSWORD);

  // service_role 可用时走 admin API 注册：账号天然"已确认"，不依赖环境 GoTrue
  // 的邮箱自动确认开关（桥接临时栈默认关、无 SMTP 可收确认信，匿名 signup 会
  // 产出未确认账号导致密码登录 400 email_not_confirmed）。422 = 已存在（幂等）。
  if (SUPABASE.serviceRoleKey) {
    const admin = await fetch(`${SUPABASE.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE.serviceRoleKey,
        Authorization: `Bearer ${SUPABASE.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (admin.ok || admin.status === 422) {
      return true;
    }
    console.warn(
      `[e2e-auth] admin 注册失败 HTTP ${admin.status}，回退匿名 signup（要求环境开启邮箱自动确认）`
    );
  }

  // 无 service_role 的回退路径：匿名 signup（要求环境开启邮箱自动确认）。
  // 只允许注册统一配置中的固定账号（TEST_ACCOUNTS）或自定义账号，禁止随机新建。
  const res = await fetch(`${SUPABASE.url}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE.anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  // 200 = 新注册；4xx（如已注册）视为已存在，不阻断
  return res.ok;
}

/** 当前 worker 应使用的固定测试账号（每个 worker 独享，并行不冲突） */
export function getWorkerTestAccount(workerIndex: number): E2ETestAccount {
  return getTestAccount(workerIndex);
}
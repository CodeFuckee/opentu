/**
 * E2E 认证辅助模块
 *
 * 当前应用在进入工作区前需要通过 Supabase 登录（AuthGate）。
 * E2E 套件采用「setup 项目注册测试账号 + UI 登录 + storageState 复用」的方案：
 * 1. 通过 GoTrue REST API 注册一个一次性测试账号（mailer_autoconfirm 直接返回会话）；
 * 2. 用该账号走真实 UI 登录表单，把会话保存为 storageState；
 * 3. 其余测试项目通过 use.storageState 以已登录状态运行。
 *
 * 环境变量（均可选）：
 * - E2E_SUPABASE_URL        默认读取 apps/web/.env，回退到代码内默认值
 * - E2E_SUPABASE_ANON_KEY   同上
 * - E2E_TEST_PASSWORD       测试账号密码（默认 E2eTest_2026!）
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export const E2E_STATE_PATH = resolve(
  __dirname,
  '../../test-results/e2e-auth-state.json'
);

function readEnvFile(): Record<string, string> {
  // Playwright 运行时 cwd 一般是 apps/web-e2e，但也可能是仓库根目录
  const candidates = [
    resolve(process.cwd(), 'apps/web/.env'),
    resolve(process.cwd(), '../../apps/web/.env'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) {
      continue;
    }
    const out: Record<string, string> = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m) {
        out[m[1]] = m[2].replace(/\r$/, '');
      }
    }
    return out;
  }
  return {};
}

export function getSupabaseConfig() {
  const env = readEnvFile();
  return {
    url:
      process.env.E2E_SUPABASE_URL ||
      env.VITE_SUPABASE_URL ||
      'http://10.37.80.25:8021',
    anonKey:
      process.env.E2E_SUPABASE_ANON_KEY ||
      env.VITE_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg4MTAyMzUyLCJleHAiOjIxMDM0NjIzNTJ9.nQP_hdmnIbCgVfsxlq6TTuRo_FKVYdrRaIDmKViiEBc',
  };
}

/** 生成一次性测试账号（每次运行唯一，避免与历史账号冲突） */
export function createE2EAccount() {
  const ts = new Date();
  const stamp =
    `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}` +
    `${String(ts.getDate()).padStart(2, '0')}_` +
    `${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}` +
    `${String(ts.getSeconds()).padStart(2, '0')}`;
  return {
    account: `e2e_${stamp}`,
    // 账号会按项目规则 normalize 为 xxx@yjk.com
    password: process.env.E2E_TEST_PASSWORD || 'E2eTest_2026!',
  };
}

/** 通过 GoTrue REST API 注册（幂等：已注册时忽略错误并返回 false） */
export async function ensureE2EAccountRegistered(
  account: string,
  password: string
): Promise<boolean> {
  const { url, anonKey } = getSupabaseConfig();
  const res = await fetch(`${url}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${account}@yjk.com`, password }),
  });
  // 200 = 新注册；4xx（如已注册）视为已存在，不阻断
  return res.ok;
}
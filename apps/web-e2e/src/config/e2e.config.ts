/**
 * E2E 测试统一配置（唯一配置入口）
 *
 * 所有测试相关的配置集中在此文件，测试代码与 fixture 禁止再自行定义：
 * - Supabase 环境（URL / anon key）
 * - 测试账号池（固定账号，禁止测试代码随机新建用户）
 * - 统一测试密码 / storageState 路径
 * - 公共等待参数
 *
 * 环境变量（均可选，覆盖顺序：环境变量 > apps/web/.env > 内置默认值）：
 * - E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY
 * - E2E_TEST_PASSWORD（所有测试账号统一密码）
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/** 读取 apps/web/.env 中的 VITE_* 配置（Playwright 运行时 cwd 可能是仓库根或 apps/web-e2e） */
function readEnvFile(): Record<string, string> {
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

const envFile = readEnvFile();

// ---------------------------------------------------------------- Supabase 环境

export const SUPABASE = {
  url:
    process.env.E2E_SUPABASE_URL ||
    envFile.VITE_SUPABASE_URL ||
    'http://10.37.80.25:8021',
  anonKey:
    process.env.E2E_SUPABASE_ANON_KEY ||
    envFile.VITE_SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg4MTAyMzUyLCJleHAiOjIxMDM0NjIzNTJ9.nQP_hdmnIbCgVfsxlq6TTuRo_FKVYdrRaIDmKViiEBc',
} as const;

// ---------------------------------------------------------------- 测试账号池

/** 测试账号（统一配置；禁止测试代码随机新建用户） */
export interface E2ETestAccount {
  /** oa 账号（小写登录名；注册邮箱为 ${id}@yjk.com，与后端 normalize 规则一致） */
  id: string;
  /** 用途说明（便于排查账号归属） */
  description: string;
}

/**
 * 固定测试账号池。
 *
 * 分配规则：按 Playwright workerIndex 取模（每个 worker 独享一个账号），
 * 因此只要并行 worker 数不超过池大小，任何测试组合都不会共用账号、
 * 不会互相污染云端数据；同一 worker 内的多个测试串行复用同一账号，
 * 画板名随机生成保证断言互不干扰。
 */
export const TEST_ACCOUNTS: E2ETestAccount[] = [
  { id: 'e2e_sync_a', description: 'e2e 账号槽位 A（worker 0，默认/auth-setup）' },
  { id: 'e2e_sync_b', description: 'e2e 账号槽位 B（worker 1）' },
  { id: 'e2e_sync_c', description: 'e2e 账号槽位 C（worker 2）' },
  { id: 'e2e_sync_d', description: 'e2e 账号槽位 D（worker 3）' },
  { id: 'e2e_sync_e', description: 'e2e 账号槽位 E（worker 4）' },
  { id: 'e2e_sync_f', description: 'e2e 账号槽位 F（worker 5）' },
  { id: 'e2e_sync_g', description: 'e2e 账号槽位 G（worker 6）' },
  { id: 'e2e_sync_h', description: 'e2e 账号槽位 H（worker 7）' },
];

/** 所有测试账号统一密码（环境变量可覆盖，保持所有环境一致） */
export const E2E_TEST_PASSWORD = process.env.E2E_TEST_PASSWORD || 'E2eTest_2026!';

/** 账号 → 注册邮箱（与后端 oa 账号 normalize 规则一致：xxx@yjk.com） */
export function accountEmail(accountId: string): string {
  return `${accountId}@yjk.com`;
}

/** 按 worker 分配固定测试账号（同一 worker 内始终同一账号） */
export function getTestAccount(workerIndex: number): E2ETestAccount {
  return TEST_ACCOUNTS[workerIndex % TEST_ACCOUNTS.length];
}

/** 默认测试账号（auth-setup 等无 worker 上下文场景使用） */
export function getDefaultTestAccount(): E2ETestAccount {
  return TEST_ACCOUNTS[0];
}

// ---------------------------------------------------------------- storageState

/** auth-setup 保存的会话文件（各测试项目以已登录状态复用） */
export const E2E_STATE_PATH = resolve(
  __dirname,
  '../../test-results/e2e-auth-state.json'
);

// ---------------------------------------------------------------- 公共等待参数

/** 常用等待超时（毫秒） */
export const TIMEOUTS = {
  /** 登录门禁 / 工作区加载 */
  authGate: 30000,
  /** 工具栏等主 UI 就绪 */
  toolbar: 15000,
  /** 元素创建 / 文件选择器等局部操作 */
  element: 10000,
  /** 画板列表渲染 / 抽屉打开 */
  drawer: 8000,
  /** 项目抽屉中出现目标画板（跨设备同步后） */
  boardInDrawer: 20000,
  /** 同步操作完成（立即同步 / 上传 / 下载） */
  syncAction: 30000,
  /** 确认对话框按钮（继续上传 / 继续下载） */
  confirmDialog: 8000,
  /** 单选工具切换生效 */
  toolCheck: 5000,
  /** 交互后的小缓冲（等待上一次操作彻底落定） */
  pause: 300,
  /** 弹窗/遮罩关闭动画后缓冲 */
  dialogClosePause: 500,
  /** 打开画板后等待渲染 */
  boardOpenPause: 2000,
} as const;

/** 轮询等待间隔（expect.poll 用） */
export const POLL_INTERVALS = {
  element: 200,
  canvas: 300,
} as const;
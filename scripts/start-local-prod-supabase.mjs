#!/usr/bin/env node
/**
 * 本地启动前端开发服务（http://localhost:7200），后端固定使用生产环境 Supabase。
 *
 * 用法：
 *   pnpm start:prod-supabase
 *   node scripts/start-local-prod-supabase.mjs
 *   node scripts/start-local-prod-supabase.mjs --url http://10.37.80.25:8021 --no-open
 *   node scripts/start-local-prod-supabase.mjs --help
 *
 * 原理：
 * - 生产 Supabase 地址与 anon key 通过进程环境变量 VITE_SUPABASE_URL /
 *   VITE_SUPABASE_ANON_KEY 注入 dev server。Vite 中已存在的进程环境变量优先级
 *   高于 apps/web/.env，因此无需改动任何仓库文件即可覆盖配置。
 * - 未显式指定时，默认值取自 apps/web/.env.example（仓库内置的生产环境配置，
 *   anon key 为公钥，安全控制由服务端 RLS / service_role 负责）。
 * - 启动前探测生产 Supabase 可达性，不可达仅告警不阻断（仍可先查看页面）。
 * - dev server 意外崩溃时自动重启（连续 MAX_CONSECUTIVE_CRASHES 次失败后放弃）；
 *   新版本 Node（v26）+ Vite 6.4 下浏览器异常断开可能触发未捕获 ECONNRESET，
 *   自动重启可避免服务一崩就只能靠 Service Worker 缓存兜底。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const WEB_ENV_EXAMPLE = path.join(ROOT_DIR, 'apps/web/.env.example');
// 与 apps/web/vite.config.ts 的 server.port 保持一致；端口被占用时 Vite 自动顺延
const DEV_SERVER_PORT = 7200;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const STARTUP_TIMEOUT_MS = 180_000;
const RESTART_DELAY_MS = 2_000;
const MAX_CONSECUTIVE_CRASHES = 5;
// 连续运行超过该时长后，"连续崩溃"计数归零重新计
const STABLE_RUNNING_MS = 60_000;
// 就绪后健康监控：连续 N 次探测失败（约 N*5s 不可达）判定崩溃。
// 注意不能只等子进程 exit——nx serve-pwa 并行的 watch-sw 常驻，serve-app
// 崩溃后 nx 父进程不会退出。
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const HEALTH_CHECK_MAX_FAILURES = 3;

function printUsage() {
  console.log(
    [
      '',
      '用法：node scripts/start-local-prod-supabase.mjs [选项]',
      '',
      '选项：',
      '  --url <supabase-url>   覆盖生产 Supabase 网关地址',
      '                         （默认取 VITE_SUPABASE_URL 环境变量或 apps/web/.env.example）',
      '  --key <anon-key>       覆盖 Supabase anon key',
      '                         （默认取 VITE_SUPABASE_ANON_KEY 环境变量或 apps/web/.env.example）',
      '  --no-open              dev server 就绪后不自动打开浏览器',
      '  -h, --help             显示本帮助',
      '',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const args = { open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') {
      args.url = argv[++i];
    } else if (arg === '--key') {
      args.key = argv[++i];
    } else if (arg === '--no-open') {
      args.open = false;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      console.error(`未知参数：${arg}`);
      printUsage();
      process.exit(1);
    }
  }
  return args;
}

function parseEnvFile(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) {
    return values;
  }
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function resolveSupabaseConfig(args) {
  const defaults = parseEnvFile(WEB_ENV_EXAMPLE);
  const url =
    args.url ||
    process.env.VITE_SUPABASE_URL ||
    defaults.VITE_SUPABASE_URL;
  const anonKey =
    args.key ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    defaults.VITE_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    console.error(
      '缺少 Supabase 配置：请通过 --url/--key、VITE_SUPABASE_URL/' +
        'VITE_SUPABASE_ANON_KEY 环境变量或 apps/web/.env.example 提供。'
    );
    process.exit(1);
  }
  return { url: url.replace(/\/+$/, ''), anonKey };
}

async function checkSupabaseReachable(url, anonKey) {
  // 只要网关返回了 HTTP 响应（含 401/403，未带鉴权头的 /auth/v1/health 就返回
  // 401）即说明网络可达；仅当请求本身异常（DNS/连接失败/超时）才判为不可达。
  const probes = [
    [`${url}/auth/v1/health`, { apikey: anonKey }],
    [`${url}/rest/v1/`, { apikey: anonKey }],
  ];
  let lastStatus = null;
  for (const [probeUrl, headers] of probes) {
    try {
      const response = await fetch(probeUrl, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      return { ok: true, status: response.status, probeUrl };
    } catch (error) {
      lastStatus = error?.message || String(error);
    }
  }
  return { ok: false, status: lastStatus };
}

// Windows 下 shell:true 只支持整条命令字符串（args 数组会触发 DEP0190 弃用警告）
function spawnCommand(command, args, options = {}) {
  if (process.platform === 'win32') {
    return spawn([command, ...args].join(' '), {
      stdio: 'inherit',
      shell: true,
      ...options,
    });
  }
  return spawn(command, args, { stdio: 'inherit', ...options });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, options);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}`))
    );
    child.on('error', reject);
  });
}

async function isUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDevServer(child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `dev server 进程提前退出（退出码 ${child.exitCode}），请查看上方日志排查`
      );
    }
    if (await isUp(DEV_SERVER_URL)) {
      return DEV_SERVER_URL;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  // 7200 被占用时 Vite 会自动顺延端口，这里扫描兜底
  for (let port = DEV_SERVER_PORT + 1; port <= DEV_SERVER_PORT + 5; port += 1) {
    const fallbackUrl = `http://localhost:${port}`;
    if (await isUp(fallbackUrl)) {
      return fallbackUrl;
    }
  }
  throw new Error(
    `等待 ${Math.round(STARTUP_TIMEOUT_MS / 1000)}s 后 dev server 仍未就绪`
  );
}

// 任意时刻只杀"当前"子进程树（自动重启会产生多任子进程）
let currentChild = null;
let userStopping = false;

function killTree(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    // shell:true 下 child.pid 是外层 shell，需要按进程树整体结束
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    child.kill('SIGTERM');
  }
}

function registerGlobalExitHandlers() {
  const stop = (exitCode) => {
    userStopping = true;
    killTree(currentChild);
    process.exit(exitCode);
  };
  process.on('SIGINT', () => stop(130));
  process.on('SIGTERM', () => stop(143));
  process.on('exit', () => killTree(currentChild));
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], {
        stdio: 'ignore',
        detached: true,
      }).on('error', () => {});
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).on(
        'error',
        () => {}
      );
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on(
        'error',
        () => {}
      );
    }
  } catch {
    // 打开浏览器失败不影响 dev server 运行
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 监控已就绪的 dev server：返回 true 表示服务持续不可达（判定崩溃）；
// 返回 false 表示子进程自行退出。
async function monitorUntilDown(child, serverUrl, exitPromise) {
  let downStreak = 0;
  for (;;) {
    if (child.exitCode !== null) {
      return false;
    }
    const result = await Promise.race([
      exitPromise.then(() => 'exit'),
      sleep(HEALTH_CHECK_INTERVAL_MS).then(() => 'tick'),
    ]);
    if (result === 'exit' || child.exitCode !== null) {
      return false;
    }
    if (await isUp(serverUrl)) {
      downStreak = 0;
      continue;
    }
    downStreak += 1;
    if (downStreak >= HEALTH_CHECK_MAX_FAILURES) {
      return true;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const { url, anonKey } = resolveSupabaseConfig(args);

  console.log('\n[本地前端 + 生产环境 Supabase]');
  console.log(`  前端地址      : ${DEV_SERVER_URL}`);
  console.log(`  Supabase 网关 : ${url}`);
  console.log(
    `  anon key      : ${anonKey.slice(0, 12)}...${anonKey.slice(-6)}\n`
  );

  if (!fs.existsSync(path.join(ROOT_DIR, 'node_modules'))) {
    console.log('[deps] 未安装依赖，先执行 pnpm install ...');
    await run('pnpm', ['install'], { cwd: ROOT_DIR });
  }

  console.log('[check] 探测生产 Supabase 可达性 ...');
  const reachable = await checkSupabaseReachable(url, anonKey);
  if (reachable.ok) {
    console.log(
      `[check] 可达 ✓（${reachable.probeUrl} → HTTP ${reachable.status}）`
    );
  } else {
    console.warn(
      `[check] ⚠ 无法连通 ${url}（${reachable.status}），登录/云端同步将不可用` +
        `（请确认是否在内网），仍继续启动前端 ...`
    );
  }

  registerGlobalExitHandlers();

  const env = {
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_ANON_KEY: anonKey,
  };
  let consecutiveCrashes = 0;
  let announced = false;

  for (;;) {
    const startedAt = Date.now();
    const child = spawnCommand('pnpm', ['start'], {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
    });
    currentChild = child;

    console.log('[start] 启动 dev server（pnpm start → nx run web:serve-pwa）...');

    let serverUrl;
    try {
      serverUrl = await waitForDevServer(child);
    } catch (error) {
      killTree(child);
      if (Date.now() - startedAt > STABLE_RUNNING_MS) {
        consecutiveCrashes = 0;
      }
      consecutiveCrashes += 1;
      if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
        console.error(
          `[error] dev server 连续 ${consecutiveCrashes} 次启动失败/崩溃，` +
            '放弃自动重启，请查看上方日志排查。'
        );
        process.exit(1);
      }
      console.warn(
        `[restart] ${error.message}，${RESTART_DELAY_MS / 1000}s 后自动重启` +
          `（连续第 ${consecutiveCrashes} 次）...`
      );
      await sleep(RESTART_DELAY_MS);
      continue;
    }

    console.log(
      `\n[ready] 前端已就绪：${serverUrl}（后端：生产环境 Supabase ${url}）`
    );
    if (args.open && !announced) {
      openBrowser(serverUrl);
    }
    console.log('[ready] 按 Ctrl+C 停止\n');
    announced = true;

    const exitPromise = new Promise((resolve) => child.on('exit', resolve));
    await monitorUntilDown(child, serverUrl, exitPromise);
    if (userStopping) {
      process.exit(0);
    }

    if (child.exitCode === null) {
      // 进程仍存活但服务持续不可达（nx 因 watch-sw 常驻不会自行退出）
      console.warn(
        '[restart] dev server 进程存活但服务持续不可达，结束进程树后重启 ...'
      );
      killTree(child);
      await Promise.race([exitPromise, sleep(15_000)]);
    }

    if (Date.now() - startedAt > STABLE_RUNNING_MS) {
      consecutiveCrashes = 0;
    }
    consecutiveCrashes += 1;
    if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      console.error(
        `[error] dev server 连续 ${consecutiveCrashes} 次意外崩溃，` +
          '放弃自动重启，请查看上方日志排查。'
      );
      process.exit(1);
    }
    console.warn(
      `[restart] dev server 崩溃，${RESTART_DELAY_MS / 1000}s 后自动重启` +
        `（连续第 ${consecutiveCrashes} 次）...`
    );
    await sleep(RESTART_DELAY_MS);
  }
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exit(1);
});

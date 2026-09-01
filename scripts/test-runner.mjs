#!/usr/bin/env node
/**
 * Yue画布 测试浏览器与运行器
 *
 * 列出项目内全部测试（E2E + 单元测试）及其用途描述，并可交互式/命令行运行指定测试。
 *
 * 用法：
 *   node scripts/test-runner.mjs                    交互模式（列表 → 选择运行）
 *   node scripts/test-runner.mjs list [e2e|unit]   列出测试清单（可只列一类）
 *   node scripts/test-runner.mjs run <关键字>      运行匹配的测试（文件名/描述匹配）
 *   node scripts/test-runner.mjs run <关键字> -g "测试名"  仅运行匹配测试名的用例
 *   node scripts/test-runner.mjs run <关键字> --headed      E2E 有头模式（弹出浏览器）
 *
 * 例子：
 *   pnpm test-runner list
 *   pnpm test-runner run cloud-sync
 *   pnpm test-runner run canvas-materials --headed
 *   pnpm test-runner run supabase-sync -g "素材"
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------- 扫描配置

/** E2E 测试根目录（Playwright） */
const E2E_ROOT = join(ROOT, 'apps', 'web-e2e', 'src');

/** 单元测试根（Vitest）：包名 → { 目录, 匹配模式 } */
const UNIT_ROOTS = [
  {
    name: 'drawnix',
    dir: join(ROOT, 'packages', 'drawnix'),
    pattern: /\.test\.[jt]sx?$/,
  },
  {
    name: 'utils',
    dir: join(ROOT, 'packages', 'utils'),
    pattern: /\.test\.[jt]sx?$/,
  },
  {
    name: 'web 应用',
    dir: join(ROOT, 'apps', 'web'),
    pattern: /\.spec\.[jt]sx?$/,
  },
];

/** E2E spec 目录 → Playwright project 映射 */
function projectForE2E(relPath) {
  if (relPath.startsWith('setup')) return 'auth-setup';
  if (relPath.startsWith('functional')) return 'functional';
  if (relPath.startsWith('features')) return 'chromium';
  if (relPath.startsWith('smoke')) return 'smoke';
  if (relPath.startsWith('visual')) return 'visual';
  if (relPath.startsWith('manual-gen')) {
    return relPath.includes('gif-') ? 'manual-video' : 'manual';
  }
  return 'functional';
}

// ---------------------------------------------------------------- 解析工具

/** 提取文件顶部 JSDoc 描述（测试「是测什么的」说明） */
function extractDescription(code) {
  const match = code.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return '';
  const lines = match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').replace(/\s*\*\/$/, '').trim())
    .filter((line) => line && !line.startsWith('@') && !line.startsWith('*'));
  return lines.slice(0, 2).join(' ').slice(0, 140);
}

/** 提取测试用例名（test/it/test.describe/describe） */
function extractTestNames(code) {
  const names = [];
  const patterns = [
    /\b(?:it|test)\.(?:skip|only|fails)?\(\s*['"]([^'"]+)['"]/g,
    /\b(?:test\.describe|describe)\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) {
      names.push(m[1]);
    }
  }
  return names;
}

/** 递归收集匹配文件（相对 root 的路径） */
function collectFiles(dir, pred) {
  const out = [];
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (pred(full)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** 读取文件并解析为测试条目 */
function parseTestFile(filePath, kind, project) {
  const code = readFileSync(filePath, 'utf8');
  const name = filePath
    .replace(/\\/g, '/')
    .split('/')
    .pop();
  const names = extractTestNames(code);
  return {
    kind,
    file: filePath,
    name,
    project,
    description: extractDescription(code),
    tests: names,
  };
}

/** E2E 条目列表 */
function collectE2ETests() {
  const e2eRootSlash = E2E_ROOT.replace(/\\/g, '/') + '/';
  return collectFiles(E2E_ROOT, (full) => /\.spec\.[jt]s$/.test(full) && !full.includes(`${join('manual-gen', 'gifs')}`))
    .map((file) => {
      const relFromSrc = file.replace(/\\/g, '/').replace(e2eRootSlash, '');
      return parseTestFile(file, 'e2e', projectForE2E(relFromSrc));
    });
}

/** 单元测试条目列表 */
function collectUnitTests() {
  const entries = [];
  for (const root of UNIT_ROOTS) {
    entries.push(
      ...collectFiles(root.dir, (full) => root.pattern.test(full)).map((file) =>
        parseTestFile(file, 'unit', root.name)
      )
    );
  }
  return entries;
}

// ---------------------------------------------------------------- 展示

/** 打印单个条目（编号 + 文件 + 描述 + 用例名） */
function printEntry(index, entry, showTests) {
  const project = entry.project ? `[${entry.project}] ` : '';
  const desc = entry.description ? ` — ${entry.description}` : '';
  console.log(`  ${String(index).padStart(3)}. ${project}${entry.name}${desc}`);
  if (showTests && entry.tests.length > 0) {
    for (const t of entry.tests.slice(0, 12)) {
      console.log(`        · ${t}`);
    }
    if (entry.tests.length > 12) {
      console.log(`        … 等 ${entry.tests.length} 个用例`);
    }
  }
}

/** 列出全部测试（可过滤类型） */
function listTests(kindFilter) {
  const e2e = collectE2ETests();
  const unit = collectUnitTests();

  if (!kindFilter || kindFilter === 'e2e') {
    console.log(`\n===== E2E 测试（Playwright · ${e2e.length} 个 spec 文件）=====`);
    e2e.forEach((entry, i) => printEntry(i + 1, entry, true));
  }
  if (!kindFilter || kindFilter === 'unit') {
    console.log(`\n===== 单元测试（Vitest · ${unit.length} 个文件）=====`);
    unit.forEach((entry, i) => printEntry(i + 1, entry, false));
  }
  console.log(`\n共 ${e2e.length + unit.length} 个测试文件。运行指定测试：pnpm test-runner run <关键字>`);
}

// ---------------------------------------------------------------- 运行

/** 在子进程中运行命令并继承输入输出 */
function runCommand(command, args, cwd) {
  // Windows 下含空格参数加引号，保证 shell 拼接正确
  const quoted = args.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  const cmd = `npx ${command} ${quoted.join(' ')}`;
  console.log(`\n▶ 运行：${cmd}  （工作目录：${cwd}）\n`);
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: 'inherit' });
    child.on('exit', (code) => resolvePromise(code ?? 0));
    child.on('error', (err) => {
      console.error('启动失败：', err.message);
      resolvePromise(1);
    });
  });
}

/** 运行匹配的测试条目；返回退出码 */
async function runMatching(entries, grep, headed) {
  if (entries.length === 0) {
    console.log('没有匹配的测试。');
    return 1;
  }
  const e2eEntries = entries.filter((e) => e.kind === 'e2e');
  const unitEntries = entries.filter((e) => e.kind === 'unit');
  let finalCode = 0;

  // E2E：按 project 分组（一个 project 一次 playwright 调用）
  if (e2eEntries.length > 0) {
    const byProject = new Map();
    for (const e of e2eEntries) {
      const files = byProject.get(e.project) ?? [];
      files.push(e.file);
      byProject.set(e.project, files);
    }
    for (const [project, files] of byProject) {
      const relFiles = files.map((f) => {
        const rel = f.replace(/\\/g, '/');
        const idx = rel.indexOf('apps/web-e2e/src/');
        return idx >= 0 ? rel.slice(idx + 'apps/web-e2e/'.length) : rel;
      });
      const args = ['test', '--project=' + project, ...(headed ? ['--headed'] : [])];
      if (grep) {
        args.push('-g', grep);
      }
      const code = await runCommand('playwright', [...args, ...relFiles], join(ROOT, 'apps', 'web-e2e'));
      finalCode = finalCode || code;
    }
  }

  // 单元测试：按包分组（一个包一次 vitest 调用）
  const byPkg = new Map();
  for (const e of unitEntries) {
    const pkg = e.project;
    const files = byPkg.get(pkg) ?? [];
    files.push(e.file);
    byPkg.set(pkg, files);
  }
  for (const [pkg, files] of byPkg) {
    const cwd = pkg === 'web 应用' ? join(ROOT, 'apps', 'web') : join(ROOT, 'packages', pkg);
    const hasVitestConfig = statSync(join(cwd, 'vitest.config.ts'), { throwIfNoEntry: false });
    // runCommand 会拼接 `npx vitest <args>`，这里只传子命令参数（不要再带 'vitest'）
    const args = ['run'];
    if (hasVitestConfig) args.push('--config', 'vitest.config.ts');
    if (grep) args.push('-t', grep);
    const cwdSlash = cwd.replace(/\\/g, '/') + '/';
    const relFiles = files.map((f) => f.replace(/\\/g, '/').replace(cwdSlash, ''));
    const code = await runCommand('vitest', [...args, ...relFiles], cwd);
    finalCode = finalCode || code;
  }
  return finalCode;
}

/** 按关键字匹配条目：文件名 / 相对路径 / 描述 / 用例名 */
function matchEntries(entries, keyword) {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  return entries.filter((e) => {
    const haystack = `${e.file} ${e.description} ${e.tests.join(' ')}`.toLowerCase();
    return e.name.toLowerCase().includes(kw) || haystack.includes(kw);
  });
}

// ---------------------------------------------------------------- 交互模式

/**
 * 缓冲队列式提问器：所有输入行先入队，prompt 按序消费。
 * 避免 readline 在同一事件循环连续派发多个 line 事件时，
 * 串行 await 注册监听过晚导致输入行丢失（非 TTY 管道场景）。
 * EOF 时等待中的 prompt 全部以空串结束，流程自然退出。
 */
function createPrompter() {
  const rl = createInterface({ input, output });
  const buffer = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(line.trim());
    } else {
      buffer.push(line.trim());
    }
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()('');
    }
  });
  return {
    prompt(text) {
      process.stdout.write(text);
      if (buffer.length > 0) {
        return Promise.resolve(buffer.shift());
      }
      if (closed) {
        return Promise.resolve('');
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

async function interactiveMode() {
  const prompter = createPrompter();
  const e2e = collectE2ETests();
  const unit = collectUnitTests();

  const askType = await prompter.prompt(
    '\n选择测试类型：\n  1. E2E 测试（Playwright，跨设备/浏览器真实交互）\n  2. 单元测试（Vitest，逻辑/数据层）\n  3. 全部\n输入 1/2/3：'
  );
  const showE2E = askType !== '2';
  const showUnit = askType !== '1';

  if (showE2E) {
    console.log(`\n===== E2E 测试（${e2e.length} 个文件）=====`);
    e2e.forEach((entry, i) => printEntry(i + 1, entry, true));
  }
  if (showUnit) {
    console.log(`\n===== 单元测试（${unit.length} 个文件）=====`);
    unit.forEach((entry, i) => printEntry(i + 1, entry, false));
  }

  const answer = await prompter.prompt(
    '\n输入要运行的测试：\n  - 编号（可多个，逗号分隔，如 "3,7"）\n  - 关键字（匹配文件名/描述/用例名，如 "cloud-sync"）\n  - 空回车退出\n> '
  );

  const trimmed = answer.trim();
  if (!trimmed) {
    prompter.close();
    console.log('已退出。');
    return 0;
  }

  let entries = [];
  const all = [...(showE2E ? e2e : []), ...(showUnit ? unit : [])];
  if (/^[\d,\s]+$/.test(trimmed)) {
    for (const part of trimmed.split(',')) {
      const idx = Number(part.trim()) - 1;
      if (idx >= 0 && idx < all.length) entries.push(all[idx]);
    }
  } else {
    entries = matchEntries(all, trimmed);
    if (entries.length === 0) {
      prompter.close();
      console.log(`没有匹配「${trimmed}」的测试。`);
      return 1;
    }
  }

  const grep = await prompter.prompt(
    '\n可选：只运行匹配此用例名的测试（-g，回车跳过）\n> '
  );
  prompter.close();

  console.log(`\n将运行 ${entries.length} 个测试文件：`);
  entries.forEach((e) => console.log(`  - [${e.project}] ${e.name}`));
  return runMatching(entries, grep, true);
}

// ---------------------------------------------------------------- CLI 入口

async function main() {
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');
  const grepIndex = args.indexOf('-g');
  const grep = grepIndex >= 0 ? args[grepIndex + 1] : undefined;
  const flags = new Set(['--headed']);
  if (grep) flags.add('-g').add(grep);
  const positional = args.filter((a) => !flags.has(a));

  const command = positional[0] ?? '';
  const rest = positional.slice(1);

  if (command === 'list') {
    const kind = rest[0] === 'unit' ? 'unit' : rest[0] === 'e2e' ? 'e2e' : undefined;
    listTests(kind);
    return 0;
  }

  if (command === 'run') {
    const keyword = rest[0];
    if (!keyword) {
      console.error('用法：pnpm test-runner run <关键字> [-g "用例名"] [--headed]');
      return 1;
    }
    const all = [...collectE2ETests(), ...collectUnitTests()];
    const entries = matchEntries(all, keyword);
    return runMatching(entries, grep, headed);
  }

  if (command) {
    console.error(`未知命令「${command}」。可用：list / run / （无参数 = 交互模式）`);
    return 1;
  }

  return interactiveMode();
}

process.exit(await main());
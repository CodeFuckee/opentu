#!/usr/bin/env node
/**
 * CI 版本号自增脚本
 *
 * 规则：从版本号最末位开始自增；每逢 100 进 1。
 *   例如：1.0.0   -> 1.0.1
 *         1.0.99  -> 1.1.0
 *         1.99.99 -> 2.0.0
 *
 * 仅修改根 package.json 的 version 字段并输出新版本号（供 CI 捕获）。
 * 用法：
 *   node scripts/ci-bump-version.js        # 自增并写入 package.json，stdout 输出新版本
 *   node scripts/ci-bump-version.js --dry  # 只打印新版本，不写入文件
 */
const fs = require('fs');
const path = require('path');

const PKG_PATH = path.join(__dirname, '..', 'package.json');
const isDryRun = process.argv.includes('--dry');

function bumpVersion(current) {
  const parts = String(current).split('.').map(Number);

  // 从最末位 +1
  let i = parts.length - 1;
  parts[i] += 1;

  // 每逢 100 进 1（自最末位向前进位）
  while (i > 0 && parts[i] >= 100) {
    parts[i] = 0;
    i -= 1;
    parts[i] += 1;
  }

  return parts.join('.');
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const next = bumpVersion(pkg.version);
  if (!isDryRun) {
    pkg.version = next;
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`[bump] ${pkg.version} -> ${next}`);
  } else {
    console.log(next);
  }
}

main();

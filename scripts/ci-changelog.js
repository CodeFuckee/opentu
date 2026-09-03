#!/usr/bin/env node
/**
 * CI CHANGELOG 处理脚本
 *
 * 功能：
 *   1. 读取 CHANGELOG.md 中 `## Unreleased` 到下一个 `## ` 标题之间的内容
 *   2. 将该内容填入新版本号 + 当前日期的 release 条目下
 *   3. 重置 `## Unreleased` 段为空（仅保留标题行）
 *
 * 用法：
 *   node scripts/ci-changelog.js <version>
 *   node scripts/ci-changelog.js 1.0.1           # 写入 CHANGELOG.md
 *   node scripts/ci-changelog.js 1.0.1 --dry     # 只打印结果，不写入文件
 *
 * CHANGELOG.md 格式约定：
 *   ## Unreleased
 *
 *   ### 🚀 Features
 *   - xxx
 *
 *   ### 🩹 Fixes
 *   - xxx
 *
 *   ## 1.0.0 (2026-05-26)
 *   ...
 */
const fs = require('fs');
const path = require('path');

const CHANGELOG_PATH = path.join(__dirname, '..', 'CHANGELOG.md');
const isDryRun = process.argv.includes('--dry');
const version = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

if (!version) {
  console.error('用法: node scripts/ci-changelog.js <version> [--dry]');
  process.exit(1);
}

/** 格式化日期为 YYYY-MM-DD */
function formatDate() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function main() {
  const content = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  const lines = content.split('\n');

  // 找到 `## Unreleased` 行
  const unreleasedIdx = lines.findIndex((l) => l.trim() === '## Unreleased');
  if (unreleasedIdx === -1) {
    console.error('CHANGELOG.md 中未找到 `## Unreleased` 标题');
    process.exit(1);
  }

  // 找到下一个 `## ` 标题（即已发布的版本）
  let nextHeaderIdx = -1;
  for (let i = unreleasedIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      nextHeaderIdx = i;
      break;
    }
  }
  if (nextHeaderIdx === -1) {
    console.error('CHANGELOG.md 中 `## Unreleased` 后未找到已发布版本标题');
    process.exit(1);
  }

  // 提取 Unreleased 段落内容（不含标题行本身，也不含末尾空行）
  // unreleasedIdx 是 `## Unreleased` 行
  // unreleasedIdx+1 可能是空行，然后是内容
  // nextHeaderIdx-1 往前是空行
  // 我们取 (unreleasedIdx, nextHeaderIdx) 之间的内容
  let unreleasedBody = lines.slice(unreleasedIdx + 1, nextHeaderIdx);

  // 去掉头部空行和尾部空行
  while (unreleasedBody.length > 0 && unreleasedBody[0].trim() === '') {
    unreleasedBody.shift();
  }
  while (unreleasedBody.length > 0 && unreleasedBody[unreleasedBody.length - 1].trim() === '') {
    unreleasedBody.pop();
  }

  if (unreleasedBody.length === 0) {
    console.log('Unreleased 段落为空，CHANGELOG 无需变更');
    return;
  }

  const dateStr = formatDate();
  const newHeader = `## ${version} (${dateStr})`;

  // 构建新的 CHANGELOG：
  // ## Unreleased
  // (空行)
  // newHeader
  // (unreleasedBody 内容)
  // (空行)
  // (原有已发布版本内容)
  const newLines = [];

  // 保留 `## Unreleased` 之前的所有行（如果有）
  for (let i = 0; i < unreleasedIdx; i++) {
    newLines.push(lines[i]);
  }

  // 重置 Unreleased 段（标题 + 空行）
  newLines.push('## Unreleased');
  newLines.push('');

  // 插入新版本条目
  newLines.push(newHeader);
  newLines.push('');
  for (const line of unreleasedBody) {
    newLines.push(line);
  }
  newLines.push('');

  // 保留原有已发布版本内容
  for (let i = nextHeaderIdx; i < lines.length; i++) {
    newLines.push(lines[i]);
  }

  // 确保文件末尾有换行
  const newContent = newLines.join('\n');
  const finalContent = newContent.endsWith('\n') ? newContent : newContent + '\n';

  if (isDryRun) {
    console.log('=== DRY RUN: CHANGELOG.md 标题结构 ===');
    const headers = newLines.filter((l) => l.startsWith('## '));
    headers.forEach((h) => console.log(h));
    console.log(`\n总行数: ${newLines.length} (原 ${lines.length} 行)`);
    console.log(`新版本条目: ## ${version} (${dateStr})`);
  } else {
    fs.writeFileSync(CHANGELOG_PATH, finalContent);
    console.log(`[changelog] 已将 Unreleased 内容归入 v${version} (${dateStr})，并重置 Unreleased 段`);
  }
}

main();

#!/usr/bin/env node
/**
 * 钉钉自定义机器人消息发送脚本（加签模式，零依赖）
 *
 * 用法：
 *   node scripts/dingtalk-notify.mjs "消息内容"
 *   node scripts/dingtalk-notify.mjs "**构建完成**\n- 分支: main" --type markdown --title "CI 通知"
 *
 * 配置（优先级：命令行参数 > 环境变量 > 仓库根目录 .env.local）：
 *   DINGTALK_WEBHOOK  机器人 webhook 地址（含 access_token）
 *   DINGTALK_SECRET   加签密钥（SEC 开头）
 *
 * 退出码：0 发送成功；1 配置缺失或钉钉返回错误（可直接用于 CI 失败通知）。
 * 文档：https://open.dingtalk.com/document/robots/custom-robot-access
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local');

// 仅补齐未设置的环境变量，不覆盖已存在的（CI 注入的变量优先于本地文件）
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// 加签：sign = urlEncode(base64(HmacSHA256(timestamp + "\n" + secret, key=secret)))
function signedUrl(webhook, secret) {
  if (!secret) return webhook;
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  return `${webhook}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

function parseArgs(argv) {
  const opts = { type: 'text', title: '通知' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--type') opts.type = argv[++i];
    else if (argv[i] === '--title') opts.title = argv[++i];
    else if (argv[i] === '--webhook') opts.webhook = argv[++i];
    else if (argv[i] === '--secret') opts.secret = argv[++i];
    else positional.push(argv[i]);
  }
  opts.content = positional.join(' ');
  return opts;
}

function buildBody({ type, content, title }) {
  if (type === 'markdown') {
    return { msgtype: 'markdown', markdown: { title, text: content } };
  }
  if (type === 'text') {
    return { msgtype: 'text', text: { content } };
  }
  throw new Error(`不支持的消息类型: ${type}（仅支持 text / markdown）`);
}

function usage() {
  console.error(
    [
      '用法: node scripts/dingtalk-notify.mjs "消息内容" [--type text|markdown] [--title 标题]',
      '      [--webhook URL] [--secret SECxxx]',
      '配置: DINGTALK_WEBHOOK / DINGTALK_SECRET 环境变量，或写入仓库根目录 .env.local',
    ].join('\n'),
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  loadEnvFile(ENV_FILE);

  const webhook = opts.webhook || process.env.DINGTALK_WEBHOOK;
  const secret = opts.secret || process.env.DINGTALK_SECRET;
  if (!webhook) {
    usage();
    console.error('\n错误: 缺少 DINGTALK_WEBHOOK 配置');
    process.exit(1);
  }
  if (!opts.content) {
    usage();
    console.error('\n错误: 缺少消息内容');
    process.exit(1);
  }

  const url = signedUrl(webhook, secret);
  const body = buildBody(opts);

  let data;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    data = await resp.json();
  } catch (err) {
    console.error('请求失败:', err.message);
    process.exit(1);
  }

  if (data.errcode !== 0) {
    console.error(`发送失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
    if (data.errcode === 310000) {
      console.error('提示: 检查加签密钥是否正确、消息内容是否包含机器人设置的安全关键词');
    }
    process.exit(1);
  }
  console.log('发送成功 ✓');
}

main();

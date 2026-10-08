#!/usr/bin/env node
/**
 * 钉钉自定义机器人消息发送脚本（加签模式，零依赖）
 *
 * 用法：
 *   node scripts/dingtalk-notify.mjs "消息内容"
 *   node scripts/dingtalk-notify.mjs "**构建完成**\n- 分支: main" --type markdown --title "CI 通知"
 *   node scripts/dingtalk-notify.mjs "请相关同学关注" --at-all          # 艾特全员
 *   node scripts/dingtalk-notify.mjs "内容" --at-all=false             # 显式关闭（默认）
 *   node scripts/dingtalk-notify.mjs "看这张图" --image test-files/test.png
 *   node scripts/dingtalk-notify.mjs "" --image https://example.com/x.png   # URL 直接发
 *
 * 图片说明：钉钉机器人只能展示"群成员客户端可达的图片 URL"。
 * - --image 传 http(s) URL：直接发送；
 * - --image 传本地路径时按配置自动择通道（--image-via 可强制指定）：
 *   ① media：配置了 DINGTALK_APP_KEY / DINGTALK_APP_SECRET（企业内部应用凭证）
 *      时上传钉钉媒体库换 mediaId（免费、永久有效、可复用）；
 *   ② gitlab：配置了 IMG_GITLAB_HOST / IMG_GITLAB_PROJECT 时上传自建 GitLab
 *      公开项目（glab CLI 已登录凭证，raw 直链匿名可访问、永久有效）；
 *   ③ server：都未配置时回退内置临时静态服务（默认 0.0.0.0:18923，URL 用本机
 *      内网 IP），发完消息后服务存活 --image-ttl 秒（默认 1800，0 = 直到 Ctrl+C）。
 *
 * 企业内部应用开通：钉钉开放平台 open.dingtalk.com → 开发者后台 → 创建企业内部
 * 应用，取 AppKey/AppSecret；若调用报权限错误，在应用"权限管理"开通媒体上传权限。
 * GitLab 图床：glab auth login 登录一次即可；公开项目里的图片对"拿到链接的人"可见。
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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local');

// 企业内部应用服务端 API 基地址（gettoken / media/upload）；测试可指向本地 mock
const API_BASE = process.env.DINGTALK_API_BASE || 'https://oapi.dingtalk.com';

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
  const opts = { type: 'text', title: '通知', atAll: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--type') opts.type = argv[++i];
    else if (argv[i] === '--title') opts.title = argv[++i];
    else if (argv[i] === '--at-all') {
      // 支持裸开关和显式赋值两种形式：--at-all / --at-all=false
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        opts.atAll = next === 'true';
        i++;
      } else {
        opts.atAll = true;
      }
    } else if (argv[i] === '--image') opts.image = argv[++i];
    else if (argv[i] === '--image-port') opts.imagePort = parseInt(argv[++i], 10);
    else if (argv[i] === '--image-ttl') opts.imageTtl = parseInt(argv[++i], 10);
    else if (argv[i] === '--image-host') opts.imageHost = argv[++i];
    else if (argv[i] === '--image-mode') opts.imageMode = argv[++i];
    else if (argv[i] === '--image-via') opts.imageVia = argv[++i];
    else if (argv[i] === '--app-key') opts.appKey = argv[++i];
    else if (argv[i] === '--app-secret') opts.appSecret = argv[++i];
    else if (argv[i] === '--webhook') opts.webhook = argv[++i];
    else if (argv[i] === '--secret') opts.secret = argv[++i];
    else positional.push(argv[i]);
  }
  opts.content = positional.join(' ');
  return opts;
}

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

// 本机内网 IPv4（多个网卡取第一个非内部地址；可用 --image-host 覆盖）
function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

// 单文件静态服务：任何 GET 都返回同一张图，不暴露文件系统其他内容
function startImageServer(filePath, port) {
  const ext = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': IMAGE_MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

// 企业内部应用 access_token（旧版服务端 API）
async function getAccessToken(appKey, appSecret) {
  const url = `${API_BASE}/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const d = await (await fetch(url)).json();
  if (d.errcode !== 0 || !d.access_token) {
    throw new Error(
      `获取 access_token 失败 errcode=${d.errcode} errmsg=${d.errmsg}` +
        `（检查 DINGTALK_APP_KEY/SECRET 是否正确、企业内部应用是否已发布并开通媒体上传权限）`,
    );
  }
  return d.access_token;
}

// 上传图片到钉钉媒体库，返回 media_id（免费、永久有效、可复用，可直接当图片地址用）
async function uploadMediaImage(filePath, appKey, appSecret) {
  const token = await getAccessToken(appKey, appSecret);
  const ext = path.extname(filePath).toLowerCase();
  const form = new FormData();
  form.append(
    'media',
    new Blob([fs.readFileSync(filePath)], { type: IMAGE_MIME[ext] || 'application/octet-stream' }),
    path.basename(filePath),
  );
  const resp = await fetch(`${API_BASE}/media/upload?access_token=${token}&type=image`, {
    method: 'POST',
    body: form,
  });
  const d = await resp.json();
  if (d.errcode !== 0 || !d.media_id) {
    throw new Error(`上传媒体文件失败 errcode=${d.errcode} errmsg=${d.errmsg}`);
  }
  return d.media_id;
}

// 上传图片到自建 GitLab 图床（公开项目 raw 直链，匿名可访问、永久有效）。
// 复用 glab CLI 的已登录凭证，无需额外 token；项目配置 IMG_GITLAB_HOST/IMG_GITLAB_PROJECT。
function uploadToGitLab(filePath) {
  const host = process.env.IMG_GITLAB_HOST;
  const project = process.env.IMG_GITLAB_PROJECT;
  const localDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  const remotePath = `notify/${localDate}/${Date.now()}-${path.basename(filePath)}`;
  const commitBody = JSON.stringify({
    branch: 'main',
    commit_message: `img: ${path.basename(filePath)} (dingtalk-notify)`,
    actions: [
      { action: 'create', file_path: remotePath, encoding: 'base64', content: fs.readFileSync(filePath).toString('base64') },
    ],
  });
  const tmp = path.join(os.tmpdir(), `dingtalk-notify-commit-${Date.now()}.json`);
  fs.writeFileSync(tmp, commitBody);
  let out;
  try {
    out = execFileSync(
      'glab',
      ['api', `projects/${encodeURIComponent(project)}/repository/commits`, '--input', tmp, '-X', 'POST'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
  } catch (err) {
    const detail = err.stderr || err.message || '';
    throw new Error(
      `GitLab 上传失败: ${detail.trim() || err}` +
        `（检查 glab 是否已安装并登录该实例：glab auth login）`,
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const commit = JSON.parse(out);
  if (!commit.id) {
    throw new Error(`GitLab 上传失败: 响应异常 ${out.slice(0, 200)}`);
  }
  const encodedPath = remotePath.split('/').map(encodeURIComponent).join('/');
  return `https://${host}/${project}/-/raw/main/${encodedPath}`;
}

// 上传 Gitee 图床（国内 CDN，raw 直链匿名可访问）。
// 配置 GITEE_TOKEN（gitee.com → 设置 → 私人令牌）+ GITEE_REPO（owner/repo）；
// 仓库不存在时自动创建公开仓库。
async function uploadToGitee(filePath) {
  const token = process.env.GITEE_TOKEN;
  const repo = process.env.GITEE_REPO;
  const giteeDefaultBranch = async () => {
    const info = await fetch(
      `https://gitee.com/api/v5/repos/${repo}?access_token=${encodeURIComponent(token)}`,
    ).then((r) => r.json());
    return info?.default_branch || 'master';
  };
  const localDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  const remotePath = `notify/${localDate}/${Date.now()}-${path.basename(filePath)}`;
  const apiPath = remotePath.split('/').map(encodeURIComponent).join('/');
  const put = (branch) =>
    fetch(`https://gitee.com/api/v5/repos/${repo}/contents/${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        branch,
        message: `img: ${path.basename(filePath)} (dingtalk-notify)`,
        content: fs.readFileSync(filePath).toString('base64'),
      }),
    }).then((r) => r.json());
  let branch = await giteeDefaultBranch();
  let d = await put(branch);
  if (d.message && /does not exist|not found/i.test(d.message)) {
    // 仓库不存在：自动创建公开仓库（auto_init 生成默认分支）后重试
    const created = await fetch('https://gitee.com/api/v5/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: token,
        name: repo.split('/').pop(),
        private: false,
        auto_init: true,
        description: '钉钉机器人通知图片图床（dingtalk-notify 自动创建，勿删）',
      }),
    }).then((r) => r.json());
    if (!created?.full_name && !created?.id) {
      throw new Error(
        `Gitee 仓库不存在且自动创建失败: ${created?.message || '未知错误'}` +
          `（检查 GITEE_REPO 格式 owner/repo、账号是否已实名认证）`,
      );
    }
    branch = await giteeDefaultBranch();
    d = await put(branch);
  }
  const url = d?.content?.download_url;
  if (!url) {
    const hint = /只允许在分支/i.test(d?.message || '')
      ? '（仓库可能是空仓库：请在 Gitee 网页勾选"使用 Readme 初始化仓库"后重试，或删除仓库由脚本自动重建）'
      : '（检查 GITEE_TOKEN 是否有效、账号是否已实名认证）';
    throw new Error(`Gitee 上传失败: ${d?.message || JSON.stringify(d).slice(0, 150)}${hint}`);
  }
  return url;
}

// 上传 SM.MS 图床（免费注册获取 token：sm.ms → Dashboard → API Token；单图 ≤5MB）
async function uploadToSmMs(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const form = new FormData();
  form.append(
    'smfile',
    new Blob([fs.readFileSync(filePath)], { type: IMAGE_MIME[ext] || 'application/octet-stream' }),
    path.basename(filePath),
  );
  const resp = await fetch('https://sm.ms/api/v2/upload', {
    method: 'POST',
    headers: { Authorization: process.env.SMMS_TOKEN },
    body: form,
  });
  const d = await resp.json();
  const url = d?.data?.url || d?.data?.link;
  if (!d.success || !url) {
    throw new Error(
      `SM.MS 上传失败 code=${d?.code} ${d?.message || ''}` +
        `（检查 SMMS_TOKEN 是否有效、图片是否 ≤5MB）`,
    );
  }
  return url;
}

// 解析 --image：http(s) URL 直接用；本地路径按配置择通道——
//   media（钉钉应用凭证）> smms（SM.MS token）> gitlab（自建图床）> server（临时服务）
// 返回 { picURL, server, via } — server 仅临时服务模式有值。
async function resolveImage(opts) {
  if (/^https?:\/\//i.test(opts.image)) {
    return { picURL: opts.image, server: null, via: 'url' };
  }
  const filePath = path.resolve(opts.image);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    throw new Error(`图片文件不存在: ${filePath}`);
  }
  const appKey = opts.appKey || process.env.DINGTALK_APP_KEY;
  const appSecret = opts.appSecret || process.env.DINGTALK_APP_SECRET;
  const giteeReady = Boolean(process.env.GITEE_TOKEN && process.env.GITEE_REPO);
  const smmsReady = Boolean(process.env.SMMS_TOKEN);
  const gitlabReady = Boolean(process.env.IMG_GITLAB_HOST && process.env.IMG_GITLAB_PROJECT);
  const via =
    opts.imageVia ||
    (appKey && appSecret
      ? 'media'
      : giteeReady
        ? 'gitee'
        : smmsReady
          ? 'smms'
          : gitlabReady
            ? 'gitlab'
            : 'server');
  if (via === 'media') {
    if (!appKey || !appSecret) {
      throw new Error(
        'media 上传需要企业内部应用凭证：配置 DINGTALK_APP_KEY / DINGTALK_APP_SECRET' +
          '（.env.local 或 --app-key/--app-secret），或用 --image-via gitee|smms|gitlab|server 走其他通道',
      );
    }
    const mediaId = await uploadMediaImage(filePath, appKey, appSecret);
    return { picURL: mediaId, server: null, via: 'media' };
  }
  if (via === 'gitee') {
    if (!giteeReady) {
      throw new Error(
        'Gitee 通道需要 GITEE_TOKEN + GITEE_REPO：gitee.com → 设置 → 私人令牌（projects 勾选），' +
          '写入 .env.local（仓库不存在会自动创建公开仓库）',
      );
    }
    const url = await uploadToGitee(filePath);
    return { picURL: url, server: null, via: 'gitee' };
  }
  if (via === 'smms') {
    if (!smmsReady) {
      throw new Error(
        'SM.MS 通道需要 SMMS_TOKEN：sm.ms 免费注册后在 Dashboard → API Token 获取，' +
          '写入 .env.local（单图限 5MB）',
      );
    }
    const url = await uploadToSmMs(filePath);
    return { picURL: url, server: null, via: 'smms' };
  }
  if (via === 'gitlab') {
    if (!gitlabReady) {
      throw new Error(
        'gitlab 图床需要配置 IMG_GITLAB_HOST / IMG_GITLAB_PROJECT（.env.local），' +
          '且 glab 已登录该 GitLab 实例（glab auth login）',
      );
    }
    const rawUrl = uploadToGitLab(filePath);
    return { picURL: rawUrl, server: null, via: 'gitlab' };
  }
  const port = opts.imagePort || 18923;
  const server = await startImageServer(filePath, port);
  const host = opts.imageHost || lanIPv4();
  const picURL = `http://${host}:${port}/${encodeURIComponent(path.basename(filePath))}`;
  return { picURL, server, via: 'server' };
}

function buildBody({ type, content, title, atAll, picURL, imageMode }) {
  const at = { isAtAll: Boolean(atAll) };
  if (picURL) {
    // 带 --image 时 --type 被忽略：默认"有文字或需 @全员→markdown 图文（@全员仅在
    // markdown 下可靠），无文字→纯图"，可用 --image-mode image|markdown 强制指定
    const useMarkdown =
      imageMode ? imageMode === 'markdown' : Boolean(content) || atAll;
    if (useMarkdown) {
      const text = content ? `${content}\n\n![通知图片](${picURL})` : `![通知图片](${picURL})`;
      return { msgtype: 'markdown', markdown: { title, text }, at };
    }
    return { msgtype: 'image', image: { picURL }, at };
  }
  if (type === 'markdown') {
    return { msgtype: 'markdown', markdown: { title, text: content }, at };
  }
  if (type === 'text') {
    return { msgtype: 'text', text: { content }, at };
  }
  throw new Error(`不支持的消息类型: ${type}（仅支持 text / markdown）`);
}

function usage() {
  console.error(
    [
      '用法: node scripts/dingtalk-notify.mjs "消息内容" [--type text|markdown] [--title 标题]',
      '      [--at-all] [--image 图片路径或URL] [--image-via media|server] [--image-port 端口]',
      '      [--image-ttl 秒] [--image-host IP] [--image-mode image|markdown]',
      '      [--app-key KEY] [--app-secret SECRET] [--webhook URL] [--secret SECxxx]',
      '      --at-all 艾特全员，可用 --at-all=false 显式关闭（默认不艾特）',
      '      --image 本地路径自动择通道：media（钉钉媒体库，需 DINGTALK_APP_KEY/',
      '      SECRET）> gitee（国内 CDN，需 GITEE_TOKEN + GITEE_REPO）> smms',
      '      （需 SMMS_TOKEN，单图 ≤5MB）> gitlab（自建图床，需 IMG_GITLAB_HOST/',
      '      PROJECT + glab 登录）> server（临时服务，端口 18923，存活 1800 秒，',
      '      0 = 直到 Ctrl+C）；--image-via 可强制指定；传 http(s) URL 则直接发送',
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
  if (!opts.content && !opts.image) {
    usage();
    console.error('\n错误: 缺少消息内容（或用 --image 指定图片）');
    process.exit(1);
  }

  let server = null;
  if (opts.image) {
    try {
      const { picURL, server: imgServer, via } = await resolveImage(opts);
      opts.picURL = picURL; // 传给 buildBody 走图片分支
      opts.imageVia = via;
      server = imgServer;
    } catch (err) {
      console.error('图片处理失败:', err.message);
      process.exit(1);
    }
    if (opts.imageMode && !['image', 'markdown'].includes(opts.imageMode)) {
      server?.close();
      console.error('错误: --image-mode 仅支持 image / markdown');
      process.exit(1);
    }
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
    server?.close();
    console.error('请求失败:', err.message);
    process.exit(1);
  }

  if (data.errcode !== 0) {
    server?.close();
    console.error(`发送失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
    if (data.errcode === 310000) {
      console.error('提示: 检查加签密钥是否正确、消息内容是否包含机器人设置的安全关键词');
    }
    process.exit(1);
  }
  console.log('发送成功 ✓');

  // 本地图片走临时服务：保持服务存活，群成员才能加载到图片；
  // media 模式图片已在钉钉媒体库，无需任何服务
  if (server) {
    const ttl = Number.isFinite(opts.imageTtl) ? opts.imageTtl : 1800;
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    console.log(`图片服务运行中: ${opts.picURL}`);
    if (ttl > 0) {
      console.log(`${ttl} 秒后自动退出（Ctrl+C 立即停止）`);
      setTimeout(stop, ttl * 1000);
    } else {
      console.log('按 Ctrl+C 停止服务');
    }
  } else if (opts.image && opts.imageVia === 'media') {
    console.log(`图片已上传钉钉媒体库（永久有效）: ${opts.picURL}`);
  } else if (opts.image && opts.imageVia === 'gitee') {
    console.log(`图片已上传 Gitee 图床（永久有效）: ${opts.picURL}`);
  } else if (opts.image && opts.imageVia === 'smms') {
    console.log(`图片已上传 SM.MS 图床（永久有效）: ${opts.picURL}`);
  } else if (opts.image && opts.imageVia === 'gitlab') {
    console.log(`图片已上传 GitLab 图床（永久有效）: ${opts.picURL}`);
  }
}

main();

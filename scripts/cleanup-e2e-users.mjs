#!/usr/bin/env node
/**
 * 清理 E2E 测试用户及其在各表中的关联数据（Supabase 自托管后端）。
 *
 * E2E 账号特征（apps/web-e2e/src/fixtures/e2e-auth.ts）：
 *   账号 = `e2e_{yyyyMMdd_HHmmss}_{毫秒+随机}`，邮箱 = `{账号}@yjk.com`，
 *   因此 auth.users.email 形如 `e2e_*@yjk.com`。
 *
 * 清理范围（按 E2E 用户的所有 user_id 收集）：
 *   1. storage.objects：huabu / yue-sync 两个私有 bucket 下以该用户名为首段的
 *      对象（无 FK 级联，必须手动删）；
 *   2. public.generation_task_bills：记账表 user_id 无外键，需手动删；
 *   3. auth.users：删除后级联清除 user_profiles / user_sync_data /
 *      user_sync_media / task_submissions / generation_usage；
 *   4. public.staff_directory：oa_account 以 e2e_ 开头的白名单残留行。
 *
 * 用法（node >= 18，无需额外依赖）：
 *   SUPABASE_URL=http://10.37.80.25:8021 \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role key> \
 *   node scripts/cleanup-e2e-users.mjs            # dry-run：仅预览
 *   node scripts/cleanup-e2e-users.mjs --apply    # 实际执行删除
 *
 * 可选参数：
 *   --url <url>         覆盖 SUPABASE_URL
 *   --key <key>         覆盖 SUPABASE_SERVICE_ROLE_KEY
 *   --pattern <regex>   覆盖邮箱匹配正则（默认 ^e2e_.*@yjk\\.com$）
 *
 * 安全说明：默认 dry-run；--apply 为不可逆破坏性操作，执行前请核对预览结果。
 */
const ARGV = parseArgs(process.argv.slice(2));
const SUPABASE_URL = (ARGV.url || process.env.SUPABASE_URL || '').replace(
  /\/+$/,
  ''
);
const SERVICE_ROLE_KEY = ARGV.key || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const EMAIL_PATTERN = new RegExp(ARGV.pattern || '^e2e_.*@yjk\\.com$', 'i');
const APPLY = Boolean(ARGV.apply);
const BUCKETS = ['huabu', 'yue-sync'];

if (!SUPABASE_URL) {
  fail('缺少 SUPABASE_URL（可用 --url 或环境变量 SUPABASE_URL 提供）');
}
if (!SERVICE_ROLE_KEY) {
  fail(
    '缺少 SUPABASE_SERVICE_ROLE_KEY（可用 --key 或环境变量提供；' +
      'service_role key 属于机密，仅存在于部署端，请向运维获取）'
  );
}

// ---------------------------------------------------------------------------
// 通用 HTTP 辅助
// ---------------------------------------------------------------------------

const HEADERS = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

/** 带 service_role 的通用请求；ok=false 时抛错 */
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: { ...HEADERS, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return res;
}

/** 取 JSON 响应 */
async function apiJson(path, opts) {
  const res = await api(path, opts);
  return res.json();
}

/** 通过 PostgREST 精确统计表内匹配行数（Content-Range 解析） */
async function countRows(table, filterQuery) {
  const res = await api(`/rest/v1/${table}?${filterQuery}`, {
    headers: {
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const range = res.headers.get('content-range') || '';
  const m = range.match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// 1. 收集 E2E 用户（email 匹配 + user_profiles.oa_account 匹配，合并去重）
// ---------------------------------------------------------------------------

/** GoTrue Admin API 分页拉取全部用户（兼容数组 / {users} 两种响应） */
async function listAllUsers() {
  const users = [];
  let page = 1;
  for (;;) {
    const data = await apiJson(
      `/auth/v1/admin/users?per_page=1000&page=${page}`
    );
    const batch = Array.isArray(data) ? data : data.users || [];
    users.push(...batch);
    if (batch.length < 1000) break;
    page += 1;
  }
  return users;
}

/** 从 user_profiles 按 oa_account 前缀查找关联 user_id（应对非 e2e 邮箱但 oa 账号为 e2e_ 的情况） */
async function findProfilesByOa() {
  const rows = await apiJson(
    '/rest/v1/user_profiles?select=user_id,oa_account&oa_account=like.e2e_%25'
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * 收集目标：返回 [{ id, email, username }]
 * username = 邮箱 @ 前缀（= storage 对象路径首段，清洗后一般不变）
 */
async function collectTargetUsers() {
  const byId = new Map();
  const users = await listAllUsers();
  for (const u of users) {
    if (u && typeof u.email === 'string' && EMAIL_PATTERN.test(u.email)) {
      byId.set(u.id, {
        id: u.id,
        email: u.email,
        username: u.email.split('@')[0],
        oa: u.email.split('@')[0],
      });
    }
  }
  for (const p of await findProfilesByOa()) {
    if (!p || !p.user_id) continue;
    const existing = byId.get(p.user_id);
    if (existing) {
      existing.oa = p.oa_account || existing.oa;
    } else {
      // 已从 auth.users 删除但 profile 残留的情况（少见），单独收集
      byId.set(p.user_id, {
        id: p.user_id,
        email: `(仅 profile: ${p.oa_account})`,
        username: p.oa_account,
        oa: p.oa_account,
        orphanProfile: true,
      });
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// 2. 统计 / 删除各关联数据
// ---------------------------------------------------------------------------

/** 列出 bucket 中某用户名目录下的全部对象（翻页直到取完） */
async function listObjects(bucket, prefix) {
  const all = [];
  let offset = 0;
  for (;;) {
    const rows = await apiJson(`/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      body: { prefix, limit: 1000, offset },
    });
    const batch = Array.isArray(rows) ? rows : [];
    all.push(...batch);
    if (batch.length < 1000) break;
    offset += batch.length;
  }
  return all;
}

async function countStorageObjects(bucket, prefix) {
  return (await listObjects(bucket, prefix)).length;
}

/** 删除 bucket 中某用户名目录下的全部对象（逐个调用 Storage API） */
async function deleteStorageObjects(bucket, prefix) {
  const objects = await listObjects(bucket, prefix);
  let deleted = 0;
  for (const o of objects) {
    // 路径按段编码（如 a/b/c.png → a%2Fb%2Fc.png 之外的逐段编码形式）
    const encoded = o.name
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    await api(`/storage/v1/object/${bucket}/${encoded}`, {
      method: 'DELETE',
    });
    deleted += 1;
  }
  return deleted;
}

/** 统计该用户的公共表行数（外键级联表，dry-run 预览用） */
async function countUserRows(userId) {
  const f = (t) => countRows(t, `user_id=eq.${userId}&select=user_id`);
  const [profiles, syncData, syncMedia, submissions, usage] = await Promise.all(
    [
      f('user_profiles'),
      f('user_sync_data'),
      f('user_sync_media'),
      f('task_submissions'),
      f('generation_usage'),
    ]
  );
  return { profiles, syncData, syncMedia, submissions, usage };
}

/** 统计 / 删除 generation_task_bills（无外键，需手动删） */
async function countTaskBills(userIds) {
  if (userIds.length === 0) return 0;
  return countRows('generation_task_bills', `user_id=in.(${userIds.join(',')})`);
}

async function deleteTaskBills(userIds) {
  const expected = await countTaskBills(userIds);
  if (expected > 0) {
    await api(
      `/rest/v1/generation_task_bills?user_id=in.(${userIds.join(',')})`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
    );
  }
  return expected;
}

/** GoTrue Admin API 删除用户（级联清 profiles/sync/task_submissions/usage） */
async function deleteUserById(userId) {
  await api(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
}

/** staff_directory 白名单残留（oa_account 以 e2e_ 开头） */
async function countStaffDir() {
  return countRows('staff_directory', 'oa_account=like.e2e_%25');
}

async function deleteStaffDir() {
  const expected = await countStaffDir();
  if (expected > 0) {
    await api(
      '/rest/v1/staff_directory?oa_account=like.e2e_%25',
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
    );
  }
  return expected;
}

// ---------------------------------------------------------------------------
// 3. 主流程
// ---------------------------------------------------------------------------

async function main() {
  log(`Supabase: ${SUPABASE_URL}`);
  log(`模式: ${APPLY ? 'APPLY（实际删除）' : 'DRY-RUN（仅预览）'}`);
  log(`邮箱匹配: ${EMAIL_PATTERN}`);
  log('');

  const users = await collectTargetUsers();
  if (users.length === 0) {
    log('未找到匹配的 E2E 用户，无需清理。');
    return;
  }

  const userIds = users.map((u) => u.id);

  // -- 预览统计 -------------------------------------------------------------
  const staffCount = await countStaffDir();
  const billCount = await countTaskBills(userIds);
  const storagePlans = [];
  let totalStorage = 0;

  for (const u of users) {
    const row = { user: u, storage: 0, table: null };
    for (const bucket of BUCKETS) {
      try {
        row.storage += await countStorageObjects(bucket, `${u.username}/`);
      } catch (e) {
        log(`  [warn] 统计 ${bucket} 失败: ${e.message}`);
      }
    }
    totalStorage += row.storage;
    row.table = await countUserRows(u.id);
    storagePlans.push(row);
  }

  log(`发现 ${users.length} 个 E2E 用户:`);
  for (const row of storagePlans) {
    const u = row.user;
    log(
      `  - ${u.email} (id=${u.id})  storage对象=${row.storage}` +
        ` 关联表行: profiles=${row.table.profiles} sync_data=${row.table.syncData}` +
        ` sync_media=${row.table.syncMedia} submissions=${row.table.submissions} usage=${row.table.usage}` +
        (u.orphanProfile ? '  [仅 profile 残留]' : '')
    );
  }
  log(
    `关联数据: storage对象=${totalStorage}, generation_task_bills=${billCount},` +
      ` staff_directory(e2e_*)=${staffCount}`
  );

  if (!APPLY) {
    log('');
    log('以上为预览。确认无误后执行:  node scripts/cleanup-e2e-users.mjs --apply');
    return;
  }

  // -- 实际删除 -------------------------------------------------------------
  log('');
  let deletedStorage = 0;
  for (const u of users) {
    for (const bucket of BUCKETS) {
      try {
        deletedStorage += await deleteStorageObjects(bucket, `${u.username}/`);
      } catch (e) {
        log(`  [warn] 删除 ${bucket} 失败: ${e.message}`);
      }
    }
  }
  const deletedBills = await deleteTaskBills(userIds);
  const deletedStaff = await deleteStaffDir();

  for (const u of users) {
    try {
      await deleteUserById(u.id);
      log(`已删除用户: ${u.email}`);
    } catch (e) {
      log(`  [warn] 删除用户 ${u.email} 失败: ${e.message}`);
    }
  }

  log('');
  log(
    `清理完成: 用户=${users.length}, storage对象=${deletedStorage},` +
      ` generation_task_bills=${deletedBills}, staff_directory=${deletedStaff}`
  );
  log('提示: 若部分对象删除因限单次 1000 条而遗漏，请重跑本脚本（幂等）。');
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, inline] = m;
    if (inline !== undefined) {
      out[key] = inline;
    } else if (key === 'apply' || key === 'dry-run') {
      out[key] = true;
    } else {
      out[key] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`错误: ${msg}\n`);
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`执行失败: ${e.stack || e.message}\n`);
  process.exit(1);
});
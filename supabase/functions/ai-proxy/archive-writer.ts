/**
 * ai-proxy 响应归档写入器（依赖注入 fetch，可单测）
 *
 * 职责（全部静默降级，绝不抛出、不阻塞主流程）：
 * 1. 解析用户名（user_profiles.oa_account → email 前缀 → null）
 * 2. 收集响应 JSON 中的 base64（白名单字段/dataURL）→ 上传 huabu bucket
 *    （路径 {username}/{YYYY-MM-DD}/output-{sha256}.{ext}，按内容去重）
 * 3. JSON 内 base64 值替换为存储路径（上传失败保留原值）
 * 4. upsert task_submissions（on_conflict=user_id,task_id），仅更新新增列
 *    upstream_response / response_file_paths，不影响前端回写的既有列
 */
import {
  collectBase64Values,
  decodeBase64ToBytes,
  extractBase64Payload,
  extractMimeFromDataUrl,
  mimeToExtension,
  sniffMimeFromBytes,
  sanitizeUsername,
  buildOutputStoragePath,
  sha256Hex,
  replaceBase64WithPaths,
} from './archive.ts';

export interface ArchiveWriterDeps {
  fetch?: typeof fetch;
}

export interface ArchiveUpstreamInput {
  supabaseUrl: string;
  serviceRoleKey: string;
  userId: string;
  /** 前端任务队列 task.id（x-task-id 头） */
  taskId: string;
  /** 登录邮箱（用户名回退来源），可为 null */
  email: string | null;
  /** 已解析的上游响应 JSON 对象 */
  upstreamJson: unknown;
  /** 归档日期（默认服务器本地日期；测试可注入固定值） */
  dateStr?: string;
}

export interface ArchiveUpstreamResult {
  /** 行是否成功写入（true 仅表示写库成功，上传失败不影响） */
  archived: boolean;
  /** 本次上传成功的 bucket 路径列表 */
  uploadedPaths: string[];
  /** 上传失败的 base64 数量（原值保留入库） */
  failedUploads: number;
}

function getLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 查询 user_profiles.oa_account；缺失/异常回退 email 前缀；都拿不到返回 null */
export async function resolveUsernameForBucket(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  email: string | null,
  deps: ArchiveWriterDeps = {}
): Promise<string | null> {
  const doFetch = deps.fetch || fetch;
  try {
    const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/user_profiles?user_id=eq.${encodeURIComponent(userId)}&select=oa_account`;
    const response = await doFetch(url, {
      method: 'GET',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: 'application/json',
      },
    });
    if (response.ok) {
      const rows = (await response.json()) as Array<{ oa_account?: string | null }>;
      const oaAccount = rows?.[0]?.oa_account;
      if (typeof oaAccount === 'string' && oaAccount.trim()) {
        return sanitizeUsername(oaAccount);
      }
    }
  } catch {
    // 查询失败走 email 回退
  }
  if (email && email.includes('@')) {
    const prefix = email.split('@')[0] ?? '';
    if (prefix.trim()) {
      return sanitizeUsername(prefix);
    }
  }
  return null;
}

/**
 * 响应归档主流程（永不抛出）。
 * - 无 task_id / 非 JSON 对象 → 直接跳过（archived=false）
 * - base64 上传失败 → 原值保留入库，仅记录 failedUploads
 * - 写库失败 → archived=false
 */
export async function archiveUpstreamResponse(
  input: ArchiveUpstreamInput,
  deps: ArchiveWriterDeps = {}
): Promise<ArchiveUpstreamResult> {
  const doFetch = deps.fetch || fetch;
  const base = (input.supabaseUrl || '').replace(/\/$/, '');
  const result: ArchiveUpstreamResult = {
    archived: false,
    uploadedPaths: [],
    failedUploads: 0,
  };

  try {
    if (!input.taskId) {
      return result;
    }
    const json = input.upstreamJson;
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      return result;
    }
    if (!base || !input.serviceRoleKey) {
      return result;
    }

    const username = await resolveUsernameForBucket(
      base,
      input.serviceRoleKey,
      input.userId,
      input.email,
      deps
    );
    const dateStr = input.dateStr || getLocalDateString();

    // 1. 收集 base64 值（去重）
    const values = collectBase64Values(json);

    // 2. 逐个上传（仅当有用户名可建目录；失败保留原值）
    const pathByValue = new Map<string, string>();
    for (const value of values) {
      if (username) {
        try {
          const payload = extractBase64Payload(value);
          if (payload === null) {
            result.failedUploads += 1;
            continue;
          }
          const bytes = decodeBase64ToBytes(payload);
          const mime =
            extractMimeFromDataUrl(value) ?? sniffMimeFromBytes(bytes);
          const ext = mimeToExtension(mime);
          const hash = await sha256Hex(bytes);
          const storagePath = buildOutputStoragePath(username, dateStr, hash, ext);

          const uploadResponse = await doFetch(
            `${base}/storage/v1/object/huabu/${storagePath}`,
            {
              method: 'POST',
              headers: {
                apikey: input.serviceRoleKey,
                Authorization: `Bearer ${input.serviceRoleKey}`,
                'Content-Type': mime,
                'x-upsert': 'true',
              },
              body: bytes,
            }
          );
          if (uploadResponse.ok) {
            pathByValue.set(value, storagePath);
            result.uploadedPaths.push(storagePath);
            continue;
          }
        } catch {
          // 上传/解码失败 → 保留原值
        }
      }
      result.failedUploads += 1;
    }

    // 3. JSON 内替换
    const archivedJson = replaceBase64WithPaths(json, pathByValue);

    // 4. 写库（upsert：冲突时仅更新请求中携带的列）
    const rowResponse = await doFetch(
      `${base}/rest/v1/task_submissions?on_conflict=user_id,task_id`,
      {
        method: 'POST',
        headers: {
          apikey: input.serviceRoleKey,
          Authorization: `Bearer ${input.serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          user_id: input.userId,
          task_id: input.taskId,
          upstream_response: archivedJson,
          response_file_paths: result.uploadedPaths,
        }),
      }
    );
    result.archived = rowResponse.ok;
  } catch {
    // 归档失败静默，不影响主流程
  }

  return result;
}
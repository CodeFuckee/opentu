/**
 * 结果交付与归档
 *
 * 交付线（语义照前端 archiveGeneratedMediaToSupabase）：
 *   上游 URL → 下载（浏览器 UA + 4 次退避重试 + 图片魔数严格校验）
 *           → 上传 ai-outputs 公开桶 {用户名}/{YYYY-MM-DD}/{sha256}.{ext}
 *           → 稳定直链 {SUPABASE_URL}/storage/v1/object/public/ai-outputs/{路径}
 * b64 响应直接解码走同一上传路径。
 * 归档失败不阻塞交付：回退上游原始 URL（或 data URL）并标记 archived=false。
 *
 * 台账线：task_submissions upsert（unique(user_id,task_id)），
 * status: submitted → completed/failed，best-effort（失败仅记日志）。
 */

import {
  backoffDelayMs,
  BROWSER_UA,
  emailPrefix,
  mimeToExtension,
  sanitizeUsername,
  sha256Hex,
  sniffImageMime,
  sleep,
  todayDateString,
} from './util.js';

const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_TIMEOUT_MS = 60000;

export function createMediaStore({
  auth,
  config,
  fetchImpl = globalThis.fetch,
  nowFn = Date.now,
  sleepImpl = sleep,
  logger = console,
}) {
  async function getStorageUsername() {
    await auth.getAccessToken(); // 确保已建立会话
    const user = auth.getUser();
    return sanitizeUsername(emailPrefix(user?.email));
  }

  /** 下载上游图片字节；重试耗尽/非图片字节 → {ok:false, error} */
  async function downloadImageBytes(url) {
    let lastError = null;
    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetchImpl(url, {
          headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*' },
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        const mime = sniffImageMime(bytes);
        if (!mime) throw new Error('响应字节不是已知图片格式（魔数校验失败）');
        return { ok: true, bytes, mime };
      } catch (error) {
        lastError = error;
        if (attempt < DOWNLOAD_ATTEMPTS - 1) {
          await sleepImpl(backoffDelayMs(attempt));
        }
      }
    }
    return { ok: false, error: lastError?.message || String(lastError) };
  }

  function buildStoragePath(username, hash, mime, date = new Date(nowFn())) {
    const safeUser = sanitizeUsername(username);
    const prefix = safeUser ? `${safeUser}/` : '';
    return `${prefix}${todayDateString(date)}/${hash}.${mimeToExtension(mime)}`;
  }

  /** 上传 ai-outputs 公开桶（公开读 + 认证写），返回稳定直链 */
  async function uploadToPublicBucket({ bytes, mime, username }) {
    const token = await auth.getAccessToken();
    const hash = sha256Hex(bytes);
    const storagePath = buildStoragePath(username, hash, mime);
    const res = await fetchImpl(
      `${config.supabaseUrl}/storage/v1/object/ai-outputs/${storagePath}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: config.supabaseAnonKey,
          'Content-Type': mime,
          'x-upsert': 'true',
        },
        body: bytes,
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `ai-outputs 上传失败: HTTP ${res.status} ${text.slice(0, 200)}`
      );
    }
    return {
      storagePath,
      hash,
      size: bytes.length,
      publicUrl: `${config.supabaseUrl}/storage/v1/object/public/ai-outputs/${storagePath}`,
    };
  }

  /**
   * 交付单个结果条目（parseImageResponseItems 的 item）。
   * b64 条目先按魔数判定真实 mime；都校验失败时按 png 兜底仅用于 data URL 场景。
   */
  async function deliverEntry(entry, { username, wantBase64 }) {
    let bytes = null;
    let mime = '';
    let sourceUrl = null;

    if (entry.kind === 'b64') {
      bytes = Buffer.from(entry.b64, 'base64');
    } else {
      sourceUrl = entry.url;
      const downloaded = await downloadImageBytes(entry.url);
      if (downloaded.ok) {
        bytes = downloaded.bytes;
      } else {
        logger.warn?.(`[store] 上游图片下载失败（交付回退原始 URL）: ${downloaded.error}`);
      }
    }

    if (bytes) {
      mime = sniffImageMime(bytes);
      if (mime) {
        try {
          const uploaded = await uploadToPublicBucket({ bytes, mime, username });
          return {
            url: uploaded.publicUrl,
            source_url: sourceUrl,
            storage_path: uploaded.storagePath,
            size: uploaded.size,
            format: mimeToExtension(mime),
            archived: true,
            base64: wantBase64 ? bytes.toString('base64') : null,
          };
        } catch (error) {
          logger.warn?.(`[store] ai-outputs 上传失败（交付回退）: ${error?.message}`);
        }
      }
    }

    // 归档失败不阻塞交付：URL 型回退原始 URL；b64 型回退 data URL
    const fallbackUrl =
      entry.kind === 'url' ? entry.url : `data:image/png;base64,${entry.b64}`;
    return {
      url: fallbackUrl,
      source_url: sourceUrl,
      storage_path: null,
      size: bytes ? bytes.length : 0,
      format: mime ? mimeToExtension(mime) : 'png',
      archived: false,
      base64: wantBase64 && entry.kind === 'b64' ? entry.b64 : null,
    };
  }

  /** 批量交付：逐条下载/转存（顺序执行，避免并发打爆上游） */
  async function deliverResults({ items, username, wantBase64 = false }) {
    const results = [];
    for (const item of items) {
      results.push(await deliverEntry(item, { username, wantBase64 }));
    }
    return results;
  }

  /** task_submissions upsert（best-effort：失败只记日志，不影响工具结果） */
  async function upsertTaskSubmission({
    taskId,
    userId,
    status,
    params,
    result,
    error,
    completedAt,
  }) {
    try {
      const token = await auth.getAccessToken();
      const body = {
        user_id: userId,
        task_id: taskId,
        type: 'image',
        status,
      };
      if (params !== undefined) body.params = params;
      if (result !== undefined) body.result = result;
      if (error !== undefined) body.error = error;
      if (completedAt) body.completed_at = new Date(completedAt).toISOString();

      const res = await fetchImpl(
        `${config.supabaseUrl}/rest/v1/task_submissions?on_conflict=user_id,task_id`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: config.supabaseAnonKey,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn?.(
          `[store] task_submissions upsert 失败: HTTP ${res.status} ${text.slice(0, 200)}`
        );
      }
    } catch (error) {
      logger.warn?.(`[store] task_submissions upsert 异常: ${error?.message || error}`);
    }
  }

  return {
    getStorageUsername,
    downloadImageBytes,
    buildStoragePath,
    uploadToPublicBucket,
    deliverResults,
    upsertTaskSubmission,
  };
}

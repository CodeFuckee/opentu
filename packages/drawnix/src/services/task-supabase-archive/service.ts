/**
 * 任务参数 Supabase 归档服务
 *
 * 职责：
 * - archiveTaskToSupabase：任务创建时归档参数（文件上传 + 入库）
 * - updateTaskSubmissionOnTerminal：终态（completed/failed/cancelled）回写同一行
 *
 * 全程 fire-and-forget、静默失败：任何异常只 console.warn，绝不抛出、不阻塞任务执行。
 * 未注册配置（未登录/宿主未接入）时直接返回。
 */
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Task } from '../../types/task.types';
import { TaskStatus } from '../../types/task.types';
import { getTaskArchiveConfig } from './runtime';
import { unifiedCacheService } from '../unified-cache-service';
import {
  buildFileEntries,
  buildFileEntryFromBlob,
  type ArchiveFileEntry,
  sanitizeUsername,
  getLocalDateString,
  collectBase64Values,
  collectVirtualMediaUrls,
  collectHttpUrls,
  extractBase64Payload,
  extractMimeFromDataUrl,
  sniffMimeFromBytes,
  decodeResponseBase64,
  mimeToExtension,
  sha256Hex,
  buildOutputStoragePath,
  readBlobAsArrayBufferSafe,
  replaceBase64WithPaths,
  replaceStringsWithPaths,
  isTerminalResponseState,
  hasOpenAIImageMedia,
} from './core';

const DEFAULT_BUCKET = 'huabu';

/** 读取当前登录用户（无会话返回 null） */
async function getCurrentUser(client: SupabaseClient): Promise<User | null> {
  const { data } = await client.auth.getSession();
  return data.session?.user ?? null;
}

/**
 * 解析用户名（bucket 目录名）：
 * 优先 user_profiles.oa_account，缺失时回退登录邮箱 @ 前缀；都拿不到返回 null（跳过）。
 */
async function resolveUsername(
  client: SupabaseClient,
  user: User
): Promise<string | null> {
  try {
    const { data } = await client
      .from('user_profiles')
      .select('oa_account')
      .eq('user_id', user.id)
      .maybeSingle();
    const oaAccount = data?.oa_account;
    if (typeof oaAccount === 'string' && oaAccount.trim()) {
      return sanitizeUsername(oaAccount);
    }
  } catch {
    // 查询失败走邮箱回退
  }

  if (user.email && user.email.includes('@')) {
    const prefix = user.email.split('@')[0] ?? '';
    if (prefix.trim()) {
      return sanitizeUsername(prefix);
    }
  }
  return null;
}

/**
 * 任务创建时归档：上传文件 + 写入 task_submissions（status=submitted）。
 *
 * 覆盖两类待上传文件：
 * - data URL（页面内联 / 剪贴板粘贴等）→ 直接解码上传
 * - 虚拟媒体路径（/asset-library/、/__aitu_cache__/，即用户上传/素材库缓存的图片）
 *   → 经 unifiedCacheService 解析为 base64 data URL 后与上者一并去重上传
 * 文件上传失败的 dataURL / 虚拟路径保留原样（不入 file_paths）；任务参数仍整体入库。
 */
export async function archiveTaskToSupabase(task: Task): Promise<void> {
  try {
    const config = getTaskArchiveConfig();
    if (!config) {
      return;
    }
    const user = await getCurrentUser(config.client);
    if (!user) {
      return;
    }
    const username = await resolveUsername(config.client, user);
    if (!username) {
      return;
    }

    const bucketName = config.bucketName?.trim() || DEFAULT_BUCKET;
    const dateStr = getLocalDateString();

    // 1. 解析虚拟媒体路径为 base64 data URL（失败静默跳过，原路径保留）
    //    virtualUrl → 解析出的 dataURL（供 buildFileEntries 收集与二次替换）
    //    解析降级（getImageForAI 返回 url 型，如素材库缓存缺失）时记录原 URL，
    //    后续回退 fetch 原路径取 blob 上传，避免参考图丢失
    const virtualUrlToDataUrl = new Map<string, string>();
    const virtualUrls = new Set<string>();
    const fetchFallbackUrls = new Set<string>();
    collectVirtualMediaUrls(task.params, virtualUrls);
    for (const virtualUrl of virtualUrls) {
      try {
        const imageData = await unifiedCacheService.getImageForAI(virtualUrl);
        if (imageData.type === 'base64') {
          virtualUrlToDataUrl.set(virtualUrl, imageData.value);
        } else {
          // getImageForAI 降级返回原始 URL（如素材库缓存缺失），回退 fetch 原路径上传
          console.warn(
            `[TaskArchive] resolve virtual media url ${virtualUrl} returned non-base64, will fetch as fallback`
          );
          fetchFallbackUrls.add(virtualUrl);
        }
      } catch (error) {
        console.warn(
          '[TaskArchive] resolve virtual media url failed, will fetch as fallback:',
          error
        );
        fetchFallbackUrls.add(virtualUrl);
      }
    }

    // 1b. 收集参数中的 http/https URL（粘贴远程参考图、素材库远程引用等），
    //     归档函数原本只识别 data URL 与虚拟 URL，遗漏远程 URL 导致 file_paths 恒为空
    collectHttpUrls(task.params, fetchFallbackUrls);

    // 2. 合成"虚拟 URL 已被替换为 dataURL"的参数快照，供提取文件条目
    const paramsWithResolved = virtualUrlToDataUrl.size
      ? (replaceStringsWithPaths(
          task.params as Record<string, unknown>,
          virtualUrlToDataUrl
        ) as Record<string, unknown>)
      : (task.params as Record<string, unknown>);

    const { entries } = await buildFileEntries(
      paramsWithResolved,
      username,
      dateStr
    );

    // 2b. 回退路径：fetch 远程/降级 URL 取 blob，构建文件条目并入上传集合
    const fetchedEntries: Array<ArchiveFileEntry> = [];
    for (const remoteUrl of fetchFallbackUrls) {
      try {
        const response = await fetch(remoteUrl, { referrerPolicy: 'no-referrer' });
        if (!response.ok) {
          console.warn(
            `[TaskArchive] fetch fallback ${remoteUrl} failed: ${response.status}, skipping`
          );
          continue;
        }
        const blob = await response.blob();
        if (blob.size === 0) {
          continue;
        }
        fetchedEntries.push(
          await buildFileEntryFromBlob(remoteUrl, blob, username, dateStr)
        );
      } catch (error) {
        console.warn(
          `[TaskArchive] fetch fallback ${remoteUrl} failed, skipping:`,
          error
        );
      }
    }
    const allEntries = [...entries, ...fetchedEntries];

    // 3. 上传到 bucket（失败静默，该条目不进入映射）
    const uploadedPaths: string[] = [];
    const succeededPaths = new Map<string, string>();
    for (const entry of allEntries) {
      const { error } = await config.client.storage
        .from(bucketName)
        .upload(entry.storagePath, entry.blob, {
          contentType: entry.mimeType,
          upsert: true,
        });
      if (error) {
        console.warn(
          '[TaskArchive] file upload failed, keeping original dataURL:',
          error
        );
        continue;
      }
      uploadedPaths.push(entry.storagePath);
      succeededPaths.set(entry.dataUrl, entry.storagePath);
      // 若该条目由虚拟 URL 解析而来，虚拟 URL 也映射到同一存储路径
      for (const [virtualUrl, dataUrl] of virtualUrlToDataUrl) {
        if (dataUrl === entry.dataUrl) {
          succeededPaths.set(virtualUrl, entry.storagePath);
        }
      }
    }

    // 4. 用存储路径替换参数中的 dataURL / 虚拟路径（只替换成功上传的）
    const paramsForDb = replaceStringsWithPaths(
      task.params as Record<string, unknown>,
      succeededPaths
    );

    // 5. 写入数据库（按 user_id+task_id 幂等）
    const { error: insertError } = await config.client
      .from('task_submissions')
      .upsert(
        {
          user_id: user.id,
          task_id: task.id,
          type: task.type,
          params: paramsForDb,
          file_paths: uploadedPaths,
          status: 'submitted',
        },
        { onConflict: 'user_id,task_id' }
      );
    if (insertError) {
      console.warn('[TaskArchive] insert task_submissions failed:', insertError);
    }
  } catch (error) {
    console.warn('[TaskArchive] archive failed (silent):', error);
  }
}

/**
 * 终态回写同一行：
 * - completed → status=completed + result + completed_at
 * - failed    → status=failed    + error + completed_at
 * - cancelled → status=cancelled + completed_at
 */
export async function updateTaskSubmissionOnTerminal(task: Task): Promise<void> {
  try {
    const config = getTaskArchiveConfig();
    if (!config) {
      return;
    }
    const user = await getCurrentUser(config.client);
    if (!user) {
      return;
    }

    const now = Date.now();
    const patch: Record<string, unknown> = {
      status: task.status,
      updated_at: new Date(now).toISOString(),
    };
    if (task.status === TaskStatus.COMPLETED) {
      patch.result = task.result ?? null;
      patch.completed_at = new Date(now).toISOString();
    } else if (task.status === TaskStatus.FAILED) {
      patch.error = task.error ?? null;
      patch.completed_at = new Date(now).toISOString();
    } else if (task.status === TaskStatus.CANCELLED) {
      patch.completed_at = new Date(now).toISOString();
    }

    const { error } = await config.client
      .from('task_submissions')
      .update(patch)
      .eq('user_id', user.id)
      .eq('task_id', task.id);
    if (error) {
      console.warn(
        '[TaskArchive] update task_submissions failed (silent):',
        error
      );
    }
  } catch (error) {
    console.warn('[TaskArchive] terminal update failed (silent):', error);
  }
}

/**
 * 响应归档（前端版，替代原 ai-proxy 服务端归档）：
 *
 * 背景：ai-proxy 以前在请求生命周期内 await 大型归档（base64 转存 bucket + 写库），
 * 拖爆 edge-runtime CPU/墙钟硬限制 → supervisor 取消 worker → 500 WorkerRequestCancelled，
 * 且被杀的归档写不进 bucket。现改为前端拿到上游响应时 fire-and-forget 归档：
 * - 条件：URL 路径 → x-task-id（taskId）关联；仅当 JSON 含 base64 值或已到终态才归档
 * - base64（b64_json/b64/base64/dataURL）→ 上传 huabu bucket（output- 前缀）+ 路径替换
 * - 写 task_submissions.upstream_response / response_file_paths（upsert，不覆盖前端终态回写列）
 *
 * 全程 fire-and-forget、静默失败：任何异常只 console.warn，绝不抛出、不阻塞请求。
 */
export async function archiveUpstreamResponseToSupabase(
  taskId: string,
  upstreamJson: unknown,
  options: { force?: boolean } = {}
): Promise<void> {
  try {
    const config = getTaskArchiveConfig();
    if (!config || !taskId) {
      return;
    }
    if (
      typeof upstreamJson !== 'object' ||
      upstreamJson === null ||
      Array.isArray(upstreamJson)
    ) {
      return;
    }

    // 中间态轮询（queued/processing）不归档；终态、含 base64 值（图片已出）、
    // 或 OpenAI 图片响应（{data:[{url}]}，无 status 但已产生媒体输出）才归档；
    // force=true（上游 ≥400 失败响应）无论内容都归档错误 JSON
    const values = collectBase64Values(upstreamJson);
    if (
      !options.force &&
      values.length === 0 &&
      !isTerminalResponseState(upstreamJson) &&
      !hasOpenAIImageMedia(upstreamJson)
    ) {
      return;
    }

    const user = await getCurrentUser(config.client);
    if (!user) {
      return;
    }
    const username = await resolveUsername(config.client, user);
    if (!username) {
      return;
    }

    const bucketName = config.bucketName?.trim() || DEFAULT_BUCKET;
    const dateStr = getLocalDateString();

    // 1. 上传 base64 → bucket（output- 路径，按内容去重；失败保留原值）
    const uploadedPaths: string[] = [];
    const pathByValue = new Map<string, string>();
    for (const value of values) {
      try {
        const payload = extractBase64Payload(value);
        if (payload === null) {
          continue;
        }
        const bytes = decodeResponseBase64(payload);
        const mime =
          extractMimeFromDataUrl(value) ?? sniffMimeFromBytes(bytes);
        const ext = mimeToExtension(mime);
        const hash = await sha256Hex(bytes);
        const storagePath = buildOutputStoragePath(username, dateStr, hash, ext);

        const { error } = await config.client.storage
          .from(bucketName)
          .upload(storagePath, new Blob([bytes], { type: mime }), {
            contentType: mime,
            upsert: true,
          });
        if (error) {
          console.warn(
            '[TaskArchive] response file upload failed, keeping original base64:',
            error
          );
          continue;
        }
        uploadedPaths.push(storagePath);
        pathByValue.set(value, storagePath);
      } catch (error) {
        console.warn('[TaskArchive] response base64 processing failed:', error);
      }
    }

    // 2. 用存储路径替换 JSON 中的 base64（只替换成功上传的）
    const archivedJson = replaceBase64WithPaths(upstreamJson, pathByValue);

    // 3. 仅更新已有行（响应归档依附于任务创建时的 submitted 行）：
    //    不能用 upsert——若该行恰好缺失会触发 INSERT，而本方法不带 type 列，
    //    违反 task_submissions.type NOT NULL（错误码 23502）。
    const { error } = await config.client
      .from('task_submissions')
      .update({
        upstream_response: archivedJson,
        response_file_paths: uploadedPaths,
      })
      .eq('user_id', user.id)
      .eq('task_id', taskId);
    if (error) {
      console.warn('[TaskArchive] response update failed (silent):', error);
    }
  } catch (error) {
    console.warn('[TaskArchive] response archive failed (silent):', error);
  }
}

/**
 * 从已 fetch 的响应触发响应归档（fire-and-forget）：
 * - clone 响应后读取 body（不消费原响应，不影响主流程）
 * - 非 JSON / 无 x-task-id 时静默跳过
 * 调用方直接 `void archiveUpstreamResponseFromFetch(taskId, response)`。
 */
export async function archiveUpstreamResponseFromFetch(
  taskId: string | undefined,
  response: Response
): Promise<void> {
  try {
    if (!taskId || !response) {
      return;
    }
    const cloned = response.clone();
    const text = await cloned.text();
    if (!text || !text.trim().startsWith('{')) {
      return;
    }
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      return; // 非 JSON 响应不归档
    }
    await archiveUpstreamResponseToSupabase(taskId, json, {
      force: !cloned.ok, // ≥400 失败响应强制归档错误 JSON
    });
  } catch (error) {
    console.warn('[TaskArchive] response archive from fetch failed (silent):', error);
  }
}

/**
 * 生成结果媒体归档（fire-and-forget）：
 *
 * 场景：适配器生图完成后，新生成的图片已由 executor 缓存到本地
 * （/__aitu_cache__/... 虚拟 URL）。本函数把本地 blob 上传 huabu bucket
 * （output-{sha256}.{ext}），并写 task_submissions.response_file_paths。
 *
 * - 上游返回 b64_json 时由 archiveUpstreamResponseToSupabase 负责；
 * - 上游返回 URL（OpenAI data[].url 格式）时，响应 JSON 里没有字节，
 *   转存必须发生在 executor 拿到可下载结果之后 —— 即本函数（补足 URL 型输出入桶）。
 * 全程 fire-and-forget、静默失败：任何异常只 console.warn，绝不抛出、不阻塞生成。
 */
export async function archiveGeneratedMediaToSupabase(
  taskId: string,
  urls: string[]
): Promise<void> {
  try {
    const config = getTaskArchiveConfig();
    if (!config || !taskId || !urls || urls.length === 0) {
      return;
    }
    const user = await getCurrentUser(config.client);
    if (!user) {
      return;
    }
    const username = await resolveUsername(config.client, user);
    if (!username) {
      return;
    }

    const bucketName = config.bucketName?.trim() || DEFAULT_BUCKET;
    const dateStr = getLocalDateString();

    const uploadedPaths: string[] = [];
    const resolved = new Set<string>();
    for (const url of urls) {
      if (resolved.has(url)) {
        continue;
      }
      resolved.add(url);
      try {
        // 优先用 unifiedCacheService 解析：本地虚拟 URL → base64 dataURL
        // 上游返回 http URL（OpenAI {data:[{url}]} 格式）时 cacheRemoteUrl 对图片
        // 原样返回不缓存，getImageForAI 对未缓存 http URL 返回 url 型 → 回退直接 fetch
        const imageData = await unifiedCacheService.getImageForAI(url);
        let bytes: Uint8Array;
        let mime: string;
        if (imageData.type === 'base64') {
          const payload = extractBase64Payload(imageData.value);
          if (payload === null) {
            continue;
          }
          bytes = decodeResponseBase64(payload);
          mime =
            extractMimeFromDataUrl(imageData.value) ?? sniffMimeFromBytes(bytes);
        } else {
          // url 型（http URL 或虚拟 URL 缓存缺失降级）：直接 fetch 取 blob
          const response = await fetch(url, { referrerPolicy: 'no-referrer' });
          if (!response.ok) {
            console.warn(
              `[TaskArchive] generated media fetch ${url} failed: ${response.status}, skipping upload`
            );
            continue;
          }
          const blob = await response.blob();
          if (blob.size === 0) {
            continue;
          }
          // 兼容不支持 blob.arrayBuffer() 的环境（部分 jsdom），复用 FileReader 回退
          const arrayBuffer = await readBlobAsArrayBufferSafe(blob);
          bytes = new Uint8Array(arrayBuffer);
          mime = blob.type || sniffMimeFromBytes(bytes);
        }
        const ext = mimeToExtension(mime);
        const hash = await sha256Hex(bytes);
        const storagePath = buildOutputStoragePath(username, dateStr, hash, ext);

        const { error } = await config.client.storage
          .from(bucketName)
          .upload(storagePath, new Blob([bytes], { type: mime }), {
            contentType: mime,
            upsert: true,
          });
        if (error) {
          console.warn(
            '[TaskArchive] generated media upload failed (silent):',
            error
          );
          continue;
        }
        uploadedPaths.push(storagePath);
      } catch (error) {
        console.warn('[TaskArchive] generated media processing failed:', error);
      }
    }

    if (uploadedPaths.length === 0) {
      return;
    }

    const { error } = await config.client
      .from('task_submissions')
      .update({
        response_file_paths: uploadedPaths,
      })
      .eq('user_id', user.id)
      .eq('task_id', taskId);
    if (error) {
      console.warn(
        '[TaskArchive] generated media update failed (silent):',
        error
      );
    }
  } catch (error) {
    console.warn('[TaskArchive] generated media archive failed (silent):', error);
  }
}

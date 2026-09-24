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
import { taskStorageWriter } from '../media-executor/task-storage-writer';
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
  buildStoragePath,
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
      console.warn('[TaskArchive] skip: no archive config registered (not logged in?)');
      return;
    }
    const user = await getCurrentUser(config.client);
    if (!user) {
      console.warn('[TaskArchive] skip: no session user');
      return;
    }
    const username = await resolveUsername(config.client, user);
    if (!username) {
      console.warn('[TaskArchive] skip: username unresolved for user', user.id);
      return;
    }

    const bucketName = config.bucketName?.trim() || DEFAULT_BUCKET;
    const dateStr = getLocalDateString();

    // 诊断：打印 task.params 中参考图相关字段的真实形态（URL 前缀/是否有 file），
    // 定位 file_paths 为空是"没收集到文件"还是"上传失败"
    const diagImages = (task.params as any)?.uploadedImages ?? (task.params as any)?.referenceImages;
    if (Array.isArray(diagImages)) {
      console.warn(
        `[TaskArchive] task ${task.id} reference images: count=${diagImages.length}, shapes=`,
        diagImages.map((img: any) => ({
          urlPrefix: typeof img?.url === 'string' ? img.url.slice(0, 40) : typeof img?.url,
          hasFile: !!img?.file,
          type: img?.type,
          name: img?.name,
        }))
      );
    } else {
      console.warn(`[TaskArchive] task ${task.id} no uploadedImages/referenceImages in params, keys=`, Object.keys(task.params as any));
    }

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
    console.warn(
      `[TaskArchive] task ${task.id} file entries: dataUrl=${entries.length} fetchFallback=${fetchedEntries.length} virtualResolved=${virtualUrlToDataUrl.size} httpOrDegraded=${fetchFallbackUrls.size}`
    );

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
          `[TaskArchive] file upload failed for ${entry.storagePath}:`,
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
    console.warn(
      `[TaskArchive] task ${task.id} upserting: file_paths=${uploadedPaths.length} bucket=${bucketName} username=${username}`
    );
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
 * - base64（b64_json/b64/base64/dataURL）→ 上传 huabu bucket + 路径替换
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

    // 1. 上传 base64 → bucket（与输入同一路径规则，按内容去重；失败保留原值）
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
          extractMimeFromDataUrl(value) ||
          sniffMimeFromBytes(bytes) ||
          'image/png';
        const ext = mimeToExtension(mime);
        const hash = await sha256Hex(bytes);
        const storagePath = buildStoragePath(username, dateStr, hash, ext);

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
 * 单个生成结果 URL 的归档产出
 */
export interface GeneratedMediaArchiveEntry {
  /** executor 传入的原始 URL（上游 http URL 或本地虚拟 URL） */
  sourceUrl: string;
  /** 归档后可稳定展示的内容寻址虚拟路径（无有效字节/缓存失败时与 sourceUrl 相同） */
  stableUrl: string;
  /** 公开桶存储路径（上传失败为 null） */
  storagePath: string | null;
  /** 实际字节数 */
  size: number;
  /** 公开桶直链（画布/素材展示用；上传失败为 undefined） */
  publicUrl?: string;
}

/** 生成结果交付公开桶（huabu 为私有桶不直接外链；公开读 + 认证写） */
const GENERATED_PUBLIC_BUCKET = 'ai-outputs';

/** 公开桶直链：画布 <img> 与素材展示直接使用（HTTP 内网部署下同样可用） */
export function buildGeneratedMediaPublicUrl(
  supabaseUrl: string,
  storagePath: string
): string {
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${GENERATED_PUBLIC_BUCKET}/${storagePath}`;
}

// 归档产出映射：sourceUrl/stableUrl → 公开桶直链（页面生命周期内复用）
const publicUrlBySource = new Map<string, string>();

function recordArchiveEntries(entries: GeneratedMediaArchiveEntry[]): void {
  for (const entry of entries) {
    if (!entry.publicUrl) {
      continue;
    }
    if (entry.sourceUrl) {
      publicUrlBySource.set(entry.sourceUrl, entry.publicUrl);
    }
    if (entry.stableUrl && entry.stableUrl !== entry.sourceUrl) {
      publicUrlBySource.set(entry.stableUrl, entry.publicUrl);
    }
  }
}

// 进行中的生成媒体归档（按内容 URL 与 taskId 双键去重）：
// 任务可能在 SW 或页面执行，但归档配置只在页面注册——插入方统一在页面侧
// `ensureGeneratedMediaArchive` 补归档并等待，拿到公开桶直链后再插入。
const pendingByUrls = new Map<string, Promise<GeneratedMediaArchiveEntry[]>>();
const pendingByTask = new Map<string, Promise<GeneratedMediaArchiveEntry[]>>();
const pendingList: Array<{
  urls: string[];
  promise: Promise<GeneratedMediaArchiveEntry[]>;
}> = [];

function startGeneratedMediaArchive(
  taskId: string,
  urls: string[]
): Promise<GeneratedMediaArchiveEntry[]> {
  const urlsKey = urls.join('|');
  const existing =
    pendingByUrls.get(urlsKey) ??
    (taskId ? pendingByTask.get(taskId) : undefined);
  if (existing) {
    return existing;
  }
  const pending = archiveGeneratedMediaToSupabase(taskId, urls)
    .then((entries) => {
      recordArchiveEntries(entries);
      return entries;
    })
    .finally(() => {
      pendingByUrls.delete(urlsKey);
      const idx = pendingList.findIndex((p) => p.promise === pending);
      if (idx >= 0) {
        pendingList.splice(idx, 1);
      }
      if (taskId) {
        pendingByTask.delete(taskId);
      }
    });
  pendingByUrls.set(urlsKey, pending);
  pendingList.push({ urls: [...urls], promise: pending });
  if (taskId) {
    pendingByTask.set(taskId, pending);
  }
  return pending;
}

/**
 * 注册 fire-and-forget 归档（执行器/completeTask 收敛点调用）。
 * 与 ensureGeneratedMediaArchive 共享去重，不会双重上传。
 */
export function registerGeneratedMediaArchive(
  taskId: string,
  urls: string[]
): void {
  startGeneratedMediaArchive(taskId, urls);
}

/**
 * 页面侧兜底：确保该组 URL 的归档已启动并等待完成（或超时）。
 * - SW 执行模式：SW 内无归档配置会静默跳过，由页面在此补归档；
 * - 未登录：config 缺失归档跳过（entries 为空），调用方回退原 URL；
 * - 超时/抛错：返回 null，不阻塞插入。
 */
export async function ensureGeneratedMediaArchive(
  taskId: string | null,
  urls: string[],
  timeoutMs: number
): Promise<GeneratedMediaArchiveEntry[] | null> {
  const usable = urls.filter(
    (u) => u && !u.startsWith('/__aitu_cache__/')
  );
  if (usable.length === 0) {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([
      startGeneratedMediaArchive(taskId ?? '', usable),
      timeout,
    ]);
  } catch (error) {
    console.warn('[TaskArchive] 等待归档失败（回退原 URL 插入）:', error);
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** 画布插入等待归档的时长上限：实测 48s~94s 不等（受上游拉取速度/图片体积影响），取 180s 余量 */
export const GENERATED_ARCHIVE_WAIT_MS = 180_000;

/**
 * 画布插入统一 URL 解析（最底层收敛点，零副作用）：
 * - 本会话已归档的 URL → 命中映射，立即返回公开桶直链；
 * - 归档进行中 → 等待其完成后返回直链；
 * - 其余 URL（通用外部图、data:、本地虚拟路径等）→ 原样返回，行为不变。
 */
export async function resolveGeneratedMediaPublicUrl(
  url: string,
  options?: { waitIfPending?: boolean; timeoutMs?: number }
): Promise<string> {
  if (
    !url ||
    (!url.startsWith('http://') && !url.startsWith('https://')) ||
    url.includes('/object/public/ai-outputs/')
  ) {
    return url;
  }
  const mapped = publicUrlBySource.get(url);
  if (mapped) {
    console.log('[TaskArchive] 画布插入命中公开桶直链:', url.slice(0, 60));
    return mapped;
  }
  // 归档进行中：等待其完成后取直链（插入环节的时序兜底）
  const pending = pendingList.find((p) => p.urls.includes(url));
  if (pending) {
    console.log('[TaskArchive] 画布插入等待归档完成:', url.slice(0, 60));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(
        () => resolve(null),
        options?.timeoutMs ?? GENERATED_ARCHIVE_WAIT_MS
      );
    });
    try {
      const entries = await Promise.race([pending.promise, timeout]);
      if (entries) {
        recordArchiveEntries(entries);
      }
    } catch (error) {
      console.warn('[TaskArchive] 等待归档失败（使用原 URL）:', error);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    const after = publicUrlBySource.get(url);
    if (after) {
      console.log('[TaskArchive] 画布插入改用公开桶直链:', url.slice(0, 60));
      return after;
    }
  }
  return url;
}

// 归档产出映射（sourceUrl/stableUrl 双键 → 公开桶直链），页面生命周期内复用：
// 所有画布插入路径经 resolveGeneratedMediaPublicUrl 在此命中，免重复归档。

/**
 * 生成结果媒体归档（fire-and-forget）：
 *
 * 场景：适配器生图完成后，把生成结果上传 huabu bucket
 * （{username}/{日期}/{sha256}.{ext}），并回写 task_submissions。
 *
 * - 上游返回 b64_json 时由 archiveUpstreamResponseToSupabase 负责；
 * - 上游返回 URL（OpenAI data[].url 格式）时，响应 JSON 里没有字节，
 *   转存必须发生在 executor 拿到可下载结果之后 —— 即本函数（补足 URL 型输出入桶）。
 *
 * 稳定性约定（替代"交付依赖上游 URL、size 恒为 0"的旧模式）：
 * - 上游下载带重试 + 媒体魔数校验（上游抖动时常见 200 + HTML 错误页，按失败重试）；
 * - bucket 上传成功后：本地以内容寻址虚拟路径缓存同一份字节，任务 result.url
 *   替换为该虚拟路径（source_url 保留原 URL 便于调试），result.size 写真实字节数
 *   —— 之后展示/下载由本地缓存稳定供给，不再依赖上游 URL；
 * - 本地任务（IndexedDB）与远端 task_submissions.result 同时回写；先本地后远端，
 *   终态回写读取本地结果，任意时序最终收敛。
 *
 * 全程 fire-and-forget、静默失败：任何异常只 console.warn，绝不抛出、不阻塞生成。
 */
export async function archiveGeneratedMediaToSupabase(
  taskId: string,
  urls: string[]
): Promise<GeneratedMediaArchiveEntry[]> {
  const entries: GeneratedMediaArchiveEntry[] = [];
  try {
    const config = getTaskArchiveConfig();
    if (!config || !taskId || !urls || urls.length === 0) {
      console.warn(
        `[TaskArchive] generated media skip: config=${!!config} taskId=${taskId} urls=${urls?.length}`
      );
      return entries;
    }
    const user = await getCurrentUser(config.client);
    if (!user) {
      console.warn('[TaskArchive] generated media skip: no session user');
      return entries;
    }
    const username = await resolveUsername(config.client, user);
    if (!username) {
      console.warn('[TaskArchive] generated media skip: username unresolved');
      return entries;
    }

    console.warn(
      `[TaskArchive] generated media task ${taskId} urls=`,
      urls.map((u) => (typeof u === 'string' ? u.slice(0, 50) : typeof u))
    );

    // 生成结果交付走公开桶：huabu 为私有桶（<img> 无法直链），画布/素材
    // 需要"等待归档完成后直接使用 bucket URL"（方案 1），故本路径固定公开桶
    const bucketName = GENERATED_PUBLIC_BUCKET;
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
            extractMimeFromDataUrl(imageData.value) ||
            sniffMimeFromBytes(bytes) ||
            'image/png';
        } else {
          // url 型（http URL 或虚拟 URL 缓存缺失降级）：带重试与魔数校验地取字节
          const fetched = await fetchGeneratedMediaWithRetry(url);
          if (!fetched) {
            continue;
          }
          bytes = fetched.bytes;
          mime = fetched.mime;
        }
        const ext = mimeToExtension(mime);
        const hash = await sha256Hex(bytes);
        const storagePath = buildStoragePath(username, dateStr, hash, ext);

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
          entries.push({
            sourceUrl: url,
            stableUrl: url,
            storagePath: null,
            size: bytes.length,
          });
          continue;
        }
        uploadedPaths.push(storagePath);

        // 本地缓存同一份字节：result.url 替换后，<img> 由 SW 从本地缓存稳定供给
        const stableUrl = await cacheArchiveBlobLocally(
          taskId,
          url,
          bytes,
          mime,
          hash
        );
        entries.push({
          sourceUrl: url,
          stableUrl,
          storagePath,
          size: bytes.length,
          publicUrl: config.supabaseUrl
            ? buildGeneratedMediaPublicUrl(config.supabaseUrl, storagePath)
            : undefined,
        });
      } catch (error) {
        console.warn('[TaskArchive] generated media processing failed:', error);
      }
    }

    if (uploadedPaths.length === 0) {
      return entries;
    }

    // 回写本地任务结果（先本地：终态回写读本地结果，任意时序最终收敛）
    await applyArchiveResultToLocalStorage(taskId, entries, uploadedPaths);

    // 服务端回写（读-合并-写，仅覆盖 response_file_paths 与 result）
    await applyArchiveResultToServerRow(
      config,
      user.id,
      taskId,
      entries,
      uploadedPaths
    );
  } catch (error) {
    console.warn('[TaskArchive] generated media archive failed (silent):', error);
  }
  return entries;
}

/** 生成结果上游下载重试次数（上游 URL 抖动/限流是常态） */
const GENERATED_MEDIA_FETCH_ATTEMPTS = 4;

/**
 * 带重试的生成结果下载：响应必须携带可识别的媒体魔数或 image/* content-type，
 * 拒绝上游抖动时返回的 200 + HTML 错误页等毒化响应。
 */
async function fetchGeneratedMediaWithRetry(
  url: string
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  let lastError: unknown = new Error('no attempt');
  for (let attempt = 0; attempt < GENERATED_MEDIA_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (blob.size === 0) {
        throw new Error('empty body');
      }
      const bytes = new Uint8Array(await readBlobAsArrayBufferSafe(blob));
      const sniffed = sniffMimeFromBytes(bytes);
      const headerMime = (blob.type || '').split(';')[0];
      const mime = sniffed || (isMediaMime(headerMime) ? headerMime : '');
      if (!mime) {
        throw new Error(
          `non-media content (sniff=${sniffed || 'unknown'}, ct=${headerMime || 'none'})`
        );
      }
      return { bytes, mime };
    } catch (error) {
      lastError = error;
      if (attempt < GENERATED_MEDIA_FETCH_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(2 ** attempt * 1500, 15000))
        );
      }
    }
  }
  console.warn(
    '[TaskArchive] generated media fetch failed after retries:',
    url.slice(0, 80),
    lastError
  );
  return null;
}

function isMediaMime(mime: string): boolean {
  return /^(image|video|audio)\//.test(mime);
}

function mediaTypeOfMime(mime: string): 'image' | 'video' | 'audio' {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'image';
}

/**
 * 把归档字节缓存到本地内容寻址虚拟路径（与 b64 结果的 cacheRemoteUrl 约定一致），
 * 返回可用于 result.url 的稳定地址；缓存失败时返回原 URL（交付退回旧行为）。
 */
async function cacheArchiveBlobLocally(
  taskId: string,
  sourceUrl: string,
  bytes: Uint8Array,
  mime: string,
  hash: string
): Promise<string> {
  const mediaType = mediaTypeOfMime(mime);
  const stableUrl = `/__aitu_cache__/${mediaType}/content-${hash}.${mimeToExtension(mime)}`;
  if (stableUrl === sourceUrl) {
    return stableUrl;
  }
  try {
    if (!(await unifiedCacheService.isCached(stableUrl))) {
      await unifiedCacheService.cacheMediaFromBlob(
        stableUrl,
        new Blob([bytes], { type: mime }),
        mediaType,
        { taskId, source: 'AI_GENERATED' }
      );
    }
  } catch (error) {
    console.warn(
      '[TaskArchive] local archive cache failed (delivery keeps source url):',
      error
    );
    return sourceUrl;
  }
  return stableUrl;
}

interface ResultLike {
  url?: string;
  urls?: string[];
  size?: number;
  source_url?: string;
  source_urls?: string[];
  public_url?: string;
  public_urls?: Array<string | undefined>;
  archived?: { at: string; via: string; paths: string[] };
  [key: string]: unknown;
}

/**
 * 把归档产出合并进任务结果：url/urls 替换为稳定地址、source_url(s) 保留原始值、
 * size 写真实字节数、archived 记录归档信息。不修改其他字段。
 */
function mergeArchiveIntoResult(
  prev: Record<string, unknown>,
  entries: GeneratedMediaArchiveEntry[],
  archivedPaths: string[]
): Record<string, unknown> {
  const next: ResultLike = { ...prev };
  const bySource = new Map(entries.map((e) => [e.sourceUrl, e]));

  const primary =
    typeof next.url === 'string' && next.url
      ? bySource.get(next.url)
      : undefined;
  if (primary?.storagePath) {
    if (primary.stableUrl !== primary.sourceUrl && next.url === primary.sourceUrl) {
      // 已归档：替换交付地址，保留原始 URL 便于调试（幂等：重跑时 url 已是稳定地址）
      next.source_url = primary.sourceUrl;
      next.url = primary.stableUrl;
    }
    if (primary.publicUrl) {
      next.public_url = primary.publicUrl;
    }
  } else if (!next.url && entries.length > 0) {
    // 服务端 result 尚未写入（归档先于终态回写完成的竞态窗口）：用首个归档产出填充
    const first = entries.find((e) => e.storagePath);
    if (first) {
      next.url = first.stableUrl;
      next.source_url = first.sourceUrl;
    }
  }

  if (Array.isArray(next.urls) && next.urls.length > 0) {
    const originals = [...next.urls];
    const mapped = originals.map((u) => {
      const entry = bySource.get(u);
      return entry?.storagePath ? entry.stableUrl : u;
    });
    if (mapped.some((u, i) => u !== originals[i])) {
      next.source_urls = originals;
      next.urls = mapped;
    }
    // 公开桶直链与 urls 一一对应（素材/画布展示优先用，缺失项回退 urls）
    const publicUrls = originals.map((u) => bySource.get(u)?.publicUrl);
    if (publicUrls.some(Boolean)) {
      next.public_urls = publicUrls;
      next.public_url = publicUrls[0];
    }
  }

  const sizeEntry =
    primary?.storagePath && primary.size > 0
      ? primary
      : entries.find((e) => e.storagePath && e.size > 0);
  if (sizeEntry) {
    next.size = sizeEntry.size;
  }

  next.archived = {
    at: new Date().toISOString(),
    via: 'generated-media-archive',
    paths: archivedPaths,
  };
  return next as Record<string, unknown>;
}

/** 本地任务结果回填（IndexedDB；任务不存在时静默跳过） */
async function applyArchiveResultToLocalStorage(
  taskId: string,
  entries: GeneratedMediaArchiveEntry[],
  uploadedPaths: string[]
): Promise<void> {
  try {
    await taskStorageWriter.updateTaskResult(taskId, (prev) => {
      if (!prev) {
        return prev;
      }
      return mergeArchiveIntoResult(
        prev as Record<string, unknown>,
        entries,
        uploadedPaths
      ) as typeof prev;
    });
  } catch (error) {
    console.warn(
      '[TaskArchive] local task result backfill failed (silent):',
      error
    );
  }
}

/** 服务端 task_submissions 回写：读现有 result → 合并 → 写回 */
async function applyArchiveResultToServerRow(
  config: { client: SupabaseClient },
  userId: string,
  taskId: string,
  entries: GeneratedMediaArchiveEntry[],
  uploadedPaths: string[]
): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const { data } = await config.client
      .from('task_submissions')
      .select('result')
      .eq('user_id', userId)
      .eq('task_id', taskId)
      .maybeSingle();
    if (data?.result && typeof data.result === 'object') {
      existing = data.result as Record<string, unknown>;
    }
  } catch (error) {
    console.warn(
      '[TaskArchive] read existing result failed (merge on empty):',
      error
    );
  }
  const merged = mergeArchiveIntoResult(existing, entries, uploadedPaths);
  const { error } = await config.client
    .from('task_submissions')
    .update({ response_file_paths: uploadedPaths, result: merged })
    .eq('user_id', userId)
    .eq('task_id', taskId);
  if (error) {
    console.warn(
      '[TaskArchive] generated media update failed (silent):',
      error
    );
  }
}

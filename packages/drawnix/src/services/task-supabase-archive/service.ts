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
import {
  buildFileEntries,
  toParamsWithFilePaths,
  sanitizeUsername,
  getLocalDateString,
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
 * 文件上传失败的 dataURL 保留原样（不入 file_paths）；任务参数仍整体入库。
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

    // 1. 提取文件条目（dataURL → 哈希 → 存储路径）
    const { entries } = await buildFileEntries(
      task.params as Record<string, unknown>,
      username,
      dateStr
    );

    // 2. 上传到 bucket（失败静默，该 dataURL 不进入映射）
    const uploadedPaths: string[] = [];
    const succeededPaths = new Map<string, string>();
    for (const entry of entries) {
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
    }

    // 3. 用存储路径替换参数中的 dataURL（只替换成功上传的）
    const paramsForDb = toParamsWithFilePaths(
      task.params as Record<string, unknown>,
      succeededPaths
    );

    // 4. 写入数据库（按 user_id+task_id 幂等）
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

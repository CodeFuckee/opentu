/**
 * 用户首字符头像（纯函数，便于单测）
 *
 * 规则：
 * 1. 若 Supabase 用户元数据中的 display name（full_name / name / display_name / nickname 等）
 *    非空，取 display name 的第一个字符；
 * 2. 否则取邮箱地址的第一个字符（字母或数字，@ 前的首字符）。
 */
import type { User } from '@supabase/supabase-js';

/** display name 可能的元数据字段（按优先级） */
const DISPLAY_NAME_KEYS = [
  'full_name',
  'display_name',
  'name',
  'nickname',
  'user_name',
  'username',
] as const;

function firstChar(value: string): string {
  return Array.from(value.trim())[0] ?? '';
}

/** 从 user_metadata 中提取 display name（找不到返回空字符串） */
export function getDisplayName(user: Pick<User, 'user_metadata'>): string {
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  for (const key of DISPLAY_NAME_KEYS) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

/** 获取用户首字符头像：优先 display name 首字，否则邮箱首字符 */
export function getUserAvatarChar(
  user: Pick<User, 'user_metadata' | 'email'> | null
): string {
  if (!user) {
    return '?';
  }

  const displayName = getDisplayName(user);
  if (displayName) {
    return firstChar(displayName);
  }

  const email = user.email?.trim() ?? '';
  if (email) {
    return firstChar(email);
  }

  return '?';
}

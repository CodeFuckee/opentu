/**
 * 用户首字符头像纯函数单测
 *
 * 规则：
 * 1. display name 非空 → 取 display name 第一个字符；
 * 2. 否则取邮箱第一个字符（字母或数字）。
 */
import { describe, it, expect } from 'vitest';
import { getDisplayName, getUserAvatarChar } from './user-avatar';
import type { User } from '@supabase/supabase-js';

function makeUser(
  userMetadata: Record<string, unknown>,
  email?: string
): Pick<User, 'user_metadata' | 'email'> {
  return { user_metadata: userMetadata, email } as Pick<
    User,
    'user_metadata' | 'email'
  >;
}

describe('getDisplayName', () => {
  it('full_name 非空时返回 full_name', () => {
    expect(
      getDisplayName(makeUser({ full_name: '张三' }))
    ).toBe('张三');
  });

  it('name 非空时返回 name', () => {
    expect(getDisplayName(makeUser({ name: 'Alice' }))).toBe('Alice');
  });

  it('display_name 非空时返回 display_name', () => {
    expect(getDisplayName(makeUser({ display_name: 'Bob' }))).toBe('Bob');
  });

  it('无 display name 字段时返回空字符串', () => {
    expect(getDisplayName(makeUser({}))).toBe('');
    expect(getDisplayName(makeUser({ avatar_url: 'x' }))).toBe('');
  });
});

describe('getUserAvatarChar', () => {
  it('display name 非空时取 display name 第一个字符', () => {
    const user = makeUser({ full_name: '张三' }, 'zhangsan@example.com');
    expect(getUserAvatarChar(user)).toBe('张');
  });

  it('display name 为空时取邮箱第一个字符', () => {
    const user = makeUser({}, 'alice@example.com');
    expect(getUserAvatarChar(user)).toBe('a');
  });

  it('邮箱以数字开头时取数字', () => {
    const user = makeUser({}, '12345@example.com');
    expect(getUserAvatarChar(user)).toBe('1');
  });

  it('user 为 null 时返回 ?', () => {
    expect(getUserAvatarChar(null)).toBe('?');
  });

  it('display name 与邮箱都为空时返回 ?', () => {
    const user = makeUser({});
    expect(getUserAvatarChar(user)).toBe('?');
  });
});

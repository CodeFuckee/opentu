/**
 * resolveSupabaseUrl 单测：登录后端地址解析（host 运行时推导）
 *
 * 背景（2026-11-14 修复）：构建期写死 10.37.80.25:8021（公司内网）导致
 * 家庭网段（10.0.0.220）打开页面后登录 Failed to fetch——同宿主机部署下
 * 未显式配置时应跟随页面 host 推导。
 */
import { describe, expect, it } from 'vitest';

import { LEGACY_DEFAULT_SUPABASE_URL, resolveSupabaseUrl } from './supabase-client';

describe('resolveSupabaseUrl', () => {
  it('构建期显式配置（≠历史默认值）时原样使用', () => {
    expect(resolveSupabaseUrl('http://10.0.0.220:8021')).toBe('http://10.0.0.220:8021');
    expect(resolveSupabaseUrl('https://supabase.example.com')).toBe('https://supabase.example.com');
  });

  it('构建期值等于历史默认值视为未显式配置 → 走页面 host 推导', () => {
    expect(
      resolveSupabaseUrl(LEGACY_DEFAULT_SUPABASE_URL, { hostname: '10.37.80.25', protocol: 'http:' })
    ).toBe('http://10.37.80.25:8021');
  });

  it('生产页面 host 推导：公司内网进入 → 同 host:8021', () => {
    expect(resolveSupabaseUrl(undefined, { hostname: '10.37.80.25', protocol: 'http:' })).toBe(
      'http://10.37.80.25:8021'
    );
  });

  it('生产页面 host 推导：家庭侧进入 → 同 host:8021', () => {
    expect(resolveSupabaseUrl(undefined, { hostname: '10.0.0.220', protocol: 'http:' })).toBe(
      'http://10.0.0.220:8021'
    );
  });

  it('localhost/127.0.0.1（本地 dev/预览）回退历史默认值', () => {
    expect(resolveSupabaseUrl(undefined, { hostname: 'localhost', protocol: 'http:' })).toBe(
      LEGACY_DEFAULT_SUPABASE_URL
    );
    expect(resolveSupabaseUrl(undefined, { hostname: '127.0.0.1', protocol: 'http:' })).toBe(
      LEGACY_DEFAULT_SUPABASE_URL
    );
  });

  it('非浏览器环境（无 location）回退历史默认值', () => {
    expect(resolveSupabaseUrl(undefined, undefined)).toBe(LEGACY_DEFAULT_SUPABASE_URL);
  });
});

/**
 * Supabase 客户端配置
 *
 * 通过 Vite 环境变量（config.ts / bootstrap 阶段注入的 import.meta.env.VITE_*）读取连接信息。
 * anon key 属于"公钥"性质、仅用于浏览器端鉴权入口，不作为机密对待
 * （真正的安全控制由服务端 RLS / service_role key 负责）。
 *
 * Supabase 地址解析（2026-11-14 修复家庭网段登录 Failed to fetch）：
 * 构建期写死单一内网地址（10.37.80.25:8021，公司内网）导致从其他可达网段
 * （家庭侧 10.0.0.220）打开页面后登录请求不可达。生产部署中页面（8088）与
 * supabase 网关（8021，0.0.0.0 监听）同在一台宿主机——故未显式配置时跟随
 * 页面 host 运行时推导，任何网段进入都天然可达；localhost/127.0.0.1
 * （本地 dev/预览，supabase 不在本机）回退历史默认值。
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/** 历史硬编码默认值（公司内网地址）；构建期显式配置为其他值时优先尊重 */
export const LEGACY_DEFAULT_SUPABASE_URL = 'http://10.37.80.25:8021';

const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg4MTAyMzUyLCJleHAiOjIxMDM0NjIzNTJ9.nQP_hdmnIbCgVfsxlq6TTuRo_FKVYdrRaIDmKViiEBc';

/**
 * 解析 Supabase 根地址：
 * 1. 构建期显式配置（VITE_SUPABASE_URL 存在且 ≠ 历史默认值）→ 原样使用；
 * 2. 浏览器环境下跟随页面 host（同宿主机部署，跨网段均可达）；
 * 3. localhost/127.0.0.1（本地 dev/预览）→ 历史默认值。
 */
export function resolveSupabaseUrl(
  buildTimeUrl: string | undefined,
  location_?: { hostname: string; protocol: string }
): string {
  if (buildTimeUrl && buildTimeUrl !== LEGACY_DEFAULT_SUPABASE_URL) {
    return buildTimeUrl;
  }
  const loc = location_ ?? (typeof window !== 'undefined' ? window.location : undefined);
  if (loc?.hostname) {
    const { hostname, protocol } = loc;
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    if (hostname && !isLoopback) {
      return `${protocol}//${hostname}:8021`;
    }
  }
  return LEGACY_DEFAULT_SUPABASE_URL;
}

const SUPABASE_URL = resolveSupabaseUrl(import.meta.env.VITE_SUPABASE_URL as string | undefined);

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}

export { SUPABASE_URL, SUPABASE_ANON_KEY };

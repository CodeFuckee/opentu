/**
 * Supabase 客户端配置
 *
 * 通过 Vite 环境变量（config.ts / bootstrap 阶段注入的 import.meta.env.VITE_*）读取连接信息，
 * 未配置时回退到 .env 里的默认值。anon key 属于"公钥"性质、仅用于浏览器端鉴权入口，
 * 不作为机密对待（真正的安全控制由服务端 RLS / service_role key 负责）。
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  'http://10.37.80.25:8021';

const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg4MTAyMzUyLCJleHAiOjIxMDM0NjIzNTJ9.nQP_hdmnIbCgVfsxlq6TTuRo_FKVYdrRaIDmKViiEBc';

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

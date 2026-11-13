/**
 * Supabase 客户端（登录门禁用）
 *
 * 与主应用（apps/web/src/supabase/supabase-client.ts）同一账号体系与连接信息；
 * anon key 属"公钥"性质、仅用于浏览器端鉴权入口，不作为机密对待
 * （真正的安全控制由服务端 RLS / service_role key 负责）。
 * 会话持久化在本 origin 的 localStorage（supabase-js 默认 sb-<ref>-auth-token），
 * 与主应用（8088/8089）各自独立登录，互不共享。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || "http://10.37.80.25:8021";

const SUPABASE_ANON_KEY =
    (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg4MTAyMzUyLCJleHAiOjIxMDM0NjIzNTJ9.nQP_hdmnIbCgVfsxlq6TTuRo_FKVYdrRaIDmKViiEBc";

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

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * 浏览器/服务端通用客户端：使用 anon key（公钥），负责 Auth（登录/注册）
 * 与 Storage（图片上传）。NEXT_PUBLIC_* 变量在构建时由 Next.js 内联。
 */
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

/**
 * 服务端专用管理客户端：使用 SUPABASE_SERVICE_ROLE_KEY 校验用户 token
 * （替换原 Firebase Admin SDK 的 verifyIdToken）。service_role 属于机密，
 * 绝不能进入浏览器 bundle，因此仅在服务端惰性创建。
 */
let supabaseAdminClient: SupabaseClient | null = null;

export const getSupabaseAdmin = (): SupabaseClient => {
  if (typeof window !== "undefined") {
    throw new Error("getSupabaseAdmin can only be used on the server");
  }

  if (!supabaseAdminClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceRoleKey) {
      throw new Error(
        "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required on the server",
      );
    }

    supabaseAdminClient = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return supabaseAdminClient;
};

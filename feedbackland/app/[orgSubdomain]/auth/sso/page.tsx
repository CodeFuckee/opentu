"use client";

/**
 * SSO 回调页：/yjk/auth/sso#token_hash=xxx
 *
 * opentu 画布点击反馈按钮 → 同源中转页 → feedbackland-sso Edge Function
 * 颁发一次性 magic link token → 跳到本页。本页用 token_hash 调 verifyOtp
 * 建立 Supabase 会话；AuthProvider 的 onAuthStateChange 会自动 upsertUser
 * 建档（首次用户自动开通），随后跳回组织主页 /yjk。
 *
 * token 一次性且短时效：缺失/过期/已用一律静默回组织主页（自带登录页接住），
 * 不在本页停留展示错误。
 */
import { useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";

export default function AuthSsoPage() {
  const params = useParams();
  const router = useRouter();
  const { session, isLoaded } = useAuth();
  const orgSubdomain = typeof params.orgSubdomain === "string" ? params.orgSubdomain : "";

  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const tokenHash = new URLSearchParams(
      window.location.hash.replace(/^#/, "")
    ).get("token_hash");

    if (!tokenHash) {
      // 无凭据（直接访问）：回组织主页，由其登录页接住
      router.replace(`/${orgSubdomain}`);
      return;
    }

    supabase.auth
      .verifyOtp({ type: "magiclink", token_hash: tokenHash })
      .then(({ error: verifyError }) => {
        if (verifyError) {
          // token 过期/已用：静默回组织主页手动登录
          console.warn("[auth/sso] verifyOtp failed:", verifyError.message);
          router.replace(`/${orgSubdomain}`);
        }
        // 成功时 onAuthStateChange → createSession 自动建档，session 出现后跳转
      })
      .catch((verifyError: unknown) => {
        console.warn("[auth/sso] verifyOtp error:", verifyError);
        router.replace(`/${orgSubdomain}`);
      });
  }, [orgSubdomain, router]);

  // 会话就绪（本页建立或原本已登录）→ 跳回组织主页
  useEffect(() => {
    if (isLoaded && session && orgSubdomain) {
      router.replace(`/${orgSubdomain}`);
    }
  }, [isLoaded, session, orgSubdomain, router]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <p style={{ fontSize: 16, fontWeight: 600 }}>正在建立登录态…</p>
      <p style={{ fontSize: 14, color: "#666" }}>
        登录成功后将自动返回反馈平台，无需手动操作。
      </p>
    </div>
  );
}

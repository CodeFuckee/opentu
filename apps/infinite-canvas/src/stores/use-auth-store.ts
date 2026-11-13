import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";

import { normalizeLoginAccount } from "@/services/auth-validation";
import { getSupabaseClient } from "@/services/supabase-client";

export type AuthStatus = "initializing" | "authenticated" | "anonymous";

type AuthStore = {
    status: AuthStatus;
    userEmail: string | null;
    loginModalOpen: boolean;
    setLoginModalOpen: (open: boolean) => void;
    applySession: (session: Session | null) => void;
    /** 会话恢复 + 状态订阅；幂等（AppProviders 挂载时调用一次） */
    init: () => Promise<void>;
    /** OA 账号（可短名）+ 密码登录；返回错误文案（null = 成功） */
    signIn: (account: string, password: string) => Promise<string | null>;
    signOut: () => Promise<void>;
};

let initStarted = false;

export const useAuthStore = create<AuthStore>()((set, get) => ({
    status: "initializing",
    userEmail: null,
    loginModalOpen: false,
    setLoginModalOpen: (open) => set({ loginModalOpen: open }),
    applySession: (session) =>
        set({
            status: session ? "authenticated" : "anonymous",
            userEmail: session?.user?.email ?? null,
        }),
    init: async () => {
        if (initStarted) return;
        initStarted = true;
        const supabase = getSupabaseClient();
        supabase.auth.onAuthStateChange((_event, session) => get().applySession(session));
        try {
            const { data } = await supabase.auth.getSession();
            get().applySession(data.session ?? null);
        } catch {
            get().applySession(null);
        }
    },
    signIn: async (account, password) => {
        const { error } = await getSupabaseClient().auth.signInWithPassword({
            email: normalizeLoginAccount(account),
            password,
        });
        return error ? error.message : null;
    },
    signOut: async () => {
        await getSupabaseClient().auth.signOut();
    },
}));

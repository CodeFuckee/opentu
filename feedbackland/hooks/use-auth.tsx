"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { supabase } from "@/lib/supabase";
import { useQueryClient } from "@tanstack/react-query";
import { User, Org, UserOrg } from "@/db/schema";
import { Selectable } from "kysely";
import { getSubdomain } from "@/lib/utils";
import { UpsertUser } from "@/lib/typings";
import { usePathname, useRouter } from "next/navigation";
import { usePlatformUrl } from "@/hooks/use-platform-url";
import { useUserSession } from "@/hooks/use-user-session";

export type Session = {
  user: Selectable<User>;
  userOrg: Selectable<UserOrg>;
  org: Selectable<Org>;
} | null;

type AuthContextType = {
  session: Session;
  isLoaded: boolean;
  isAdmin: boolean;
  signInWithEmail: ({
    email,
    password,
  }: {
    email: string;
    password: string;
  }) => Promise<Session>;
  signUpWithEmail: ({
    name,
    email,
    password,
  }: {
    name: string;
    email: string;
    password: string;
  }) => Promise<Session>;
  signOnWithGoogle: () => Promise<Session>;
  signOnWithMicrosoft: () => Promise<Session>;
  signOut: () => Promise<null>;
  refreshSession: () => void;
};

const AuthContext = createContext<AuthContextType>({
  session: null,
  isLoaded: false,
  isAdmin: false,
  signInWithEmail: async () => ({}) as Session,
  signUpWithEmail: async () => ({}) as Session,
  signOnWithGoogle: async () => ({}) as Session,
  signOnWithMicrosoft: async () => ({}) as Session,
  signOut: async () => null,
  refreshSession: () => {},
});

const upsertUser = async ({
  userId,
  email,
  name,
  photoURL,
}: {
  userId: string;
  email: string;
  name: string | null;
  photoURL: string | null;
}) => {
  try {
    const orgSubdomain =
      sessionStorage?.getItem("orgSubdomain") || getSubdomain();

    if (!orgSubdomain) {
      throw new Error("Missing email or org subdomain");
    }

    const input: UpsertUser = {
      userId,
      email,
      name,
      photoURL,
      orgSubdomain,
    };

    // 带上 access token，让 /api/user/upsert-user 在服务端校验用户身份，
    // 避免任何人伪造任意 userId 写库（原实现未认证直写）。
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();

    const response = await fetch("/api/user/upsert-user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(currentSession?.access_token && {
          Authorization: `Bearer ${currentSession.access_token}`,
        }),
      },
      body: JSON.stringify(input),
    });

    const session: Session = await response.json();

    if (session) {
      return session;
    } else {
      throw new Error("upsertUser did not return anything");
    }
  } catch (err) {
    throw err;
  }
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const queryClient = useQueryClient();
  const router = useRouter();
  const platformUrl = usePlatformUrl();
  const pathname = usePathname();

  const [session, setSession] = useState<Session>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const {
    query: { refetch: refetchUserSession },
  } = useUserSession({ enabled: false });

  const destroySession = useCallback(() => {
    queryClient.invalidateQueries();
    setSession(null);
    setIsLoaded(true);
  }, [setSession, setIsLoaded, queryClient]);

  const isAdmin = session?.userOrg?.role === "admin";

  const createSession = useCallback(
    async ({
      userId,
      email,
      name,
      photoURL,
    }: {
      userId: string;
      email: string;
      name: string | null;
      photoURL: string | null;
    }) => {
      let newSession: Session = null;

      queryClient.invalidateQueries();

      try {
        const { user, userOrg, org } = await upsertUser({
          userId,
          email,
          name,
          photoURL,
        });

        newSession = {
          user: user,
          userOrg: userOrg,
          org: org,
        };

        setSession(newSession);
        setIsLoaded(true);
      } catch {
        destroySession();
      }

      return newSession;
    },
    [setSession, queryClient, destroySession],
  );

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;

      if (user?.id) {
        createSession({
          userId: user.id,
          email: user.email || `${user.id}@no-email.com`,
          name:
            (user.user_metadata?.displayName as string | undefined) ??
            // 主应用（Yue画布）注册的账号没有 displayName 元数据，
            // 回退到邮箱前缀，避免登录后显示 "Unnamed user"
            user.email?.split("@")[0] ??
            null,
          photoURL:
            (user.user_metadata?.avatar_url as string | undefined) ?? null,
        });
      } else {
        destroySession();
      }
    });

    return () => subscription.unsubscribe();
  }, [createSession, destroySession]);

  const signInWithEmail = async ({
    email,
    password,
  }: {
    email: string;
    password: string;
  }) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      const user = data.user;
      const session = await createSession({
        userId: user.id,
        email: user.email || `${user.id}@no-email.com`,
        name:
          (user.user_metadata?.displayName as string | undefined) ??
          // 主应用（Yue画布）注册的账号没有 displayName 元数据，
          // 回退到邮箱前缀，避免登录后显示 "Unnamed user"
          user.email?.split("@")[0] ??
          null,
        photoURL:
          (user.user_metadata?.avatar_url as string | undefined) ?? null,
      });
      return session;
    } catch (err) {
      throw err;
    }
  };

  const signUpWithEmail = async ({
    name,
    email,
    password,
  }: {
    name: string;
    email: string;
    password: string;
  }) => {
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { displayName: name },
        },
      });
      if (error) throw error;
      const user = data.user;
      if (!user) throw new Error("Sign up did not return a user");
      // 邮箱确认关闭时立即可用；开启确认时等待会话就绪
      await supabase.auth.updateUser({
        data: { displayName: name },
      });
      const session = await createSession({
        userId: user.id,
        email: user.email || email,
        name,
        photoURL:
          (user.user_metadata?.avatar_url as string | undefined) ?? null,
      });
      return session;
    } catch (err) {
      throw err;
    }
  };

  const signOnWithGoogle = async () => {
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.href },
      });
      if (error) throw error;
      // OAuth 为整页跳转流程：页面跳转后 onAuthStateChange 会回调 createSession，
      // 此 Promise 不会在当前页面 resolve（与 Firebase 弹窗流程不同）。
      void data;
      return null;
    } catch (err) {
      throw err;
    }
  };

  const signOnWithMicrosoft = async () => {
    try {
      // Supabase OAuth 用 azure（Microsoft Entra/AD）provider 对接微软账号
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "azure",
        options: { redirectTo: window.location.href },
      });
      if (error) throw error;
      void data;
      return null;
    } catch (err) {
      throw err;
    }
  };

  const signOut = async () => {
    try {
      await supabase.auth.signOut();

      destroySession();

      if (pathname.includes("/admin") && platformUrl) {
        router.push(platformUrl);
      }

      return null;
    } catch (err) {
      throw err;
    }
  };

  const refreshSession = async () => {
    const { data: session } = await refetchUserSession();

    if (session) {
      setSession(session);
    } else {
      destroySession();
    }
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        isLoaded,
        isAdmin,
        signInWithEmail,
        signUpWithEmail,
        signOnWithGoogle,
        signOnWithMicrosoft,
        signOut,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);

/**
 * Supabase 认证上下文
 *
 * 提供注册（signUp）、登录（signInWithPassword）、退出（signOut）及会话订阅。
 * 会话状态通过 onAuthStateChange 与组件保持同步，登录成功后不再需要手动刷新。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseClient } from './supabase-client';
import { SUPABASE_URL } from './supabase-client';
import { normalizeLoginAccount } from './auth-validation';
import type { RegisterEligibility } from './auth-validation';
import { configureManagedRouting } from '@drawnix/drawnix/runtime';

export type AuthStatus =
  | { state: 'unknown' }
  | { state: 'authenticated'; session: Session; user: User }
  | { state: 'unauthenticated' };

interface AuthContextValue {
  status: AuthStatus;
  isReady: boolean;
  user: User | null;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  /** 查询邮箱是否已注册；返回 null 表示查询失败（函数未部署/网络错误） */
  checkEmailRegistered: (email: string) => Promise<boolean | null>;
  /** 注册资格校验；返回 null 表示查询失败 */
  checkRegisterEligibility: (oaAccount: string) => Promise<RegisterEligibility | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** 注册成功后，根据 staff_directory 字段填写 user_profiles（fire-and-forget，失败仅警告不阻塞） */
async function syncStaffProfile(userId: string, account: string): Promise<void> {
  try {
    await getSupabaseClient().functions.invoke('sync-staff-profile', {
      body: { userId, oaAccount: account },
    });
  } catch (error) {
    console.warn('[Auth] sync staff profile failed:', error);
  }
}

/** 注册成功后，调用 newapi-key 获取 apikey（fire-and-forget，失败仅警告不阻塞） */
async function requestNewApiKey(userId: string, account: string): Promise<void> {
  try {
    await getSupabaseClient().functions.invoke('newapi-key', {
      body: { userId, oaAccount: account },
    });
  } catch (error) {
    console.warn('[Auth] newapi-key request failed:', error);
  }
}

/**
 * 取当前会话 access_token（供 ai-proxy 托管路由使用）。
 * 临期（<30s）时先刷新一次，避免把过期 JWT 发给代理。
 */
async function getAccessToken(): Promise<string | null> {
  const client = getSupabaseClient();
  const { data } = await client.auth.getSession();
  const session = data.session;
  const token = session?.access_token;
  if (!token) {
    return null;
  }
  const expiresAtMs = (session?.expires_at ?? 0) * 1000;
  if (expiresAtMs - Date.now() < 30_000) {
    const { data: refreshed } = await client.auth.refreshSession();
    return refreshed.session?.access_token ?? token;
  }
  return token;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>({ state: 'unknown' });

  useEffect(() => {
    const client = getSupabaseClient();

    client.auth.getSession().then(({ data, error }) => {
      if (error) {
        console.warn('[Auth] failed to restore session:', error);
        setStatus({ state: 'unauthenticated' });
        return;
      }
      setStatus(
        data.session && data.session.user
          ? {
              state: 'authenticated',
              session: data.session,
              user: data.session.user,
            }
          : { state: 'unauthenticated' }
      );
    });

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      setStatus(
        session && session.user
          ? { state: 'authenticated', session, user: session.user }
          : { state: 'unauthenticated' }
      );
    });

    return () => subscription.unsubscribe();
  }, []);

  // 登录态变化时同步托管上游路由：登录 → 流量经 ai-proxy（服务端计量生图额度）；
  // 未登录/退出 → 回到本地直连模式
  useEffect(() => {
    if (status.state === 'authenticated') {
      configureManagedRouting({
        supabaseUrl: SUPABASE_URL,
        getToken: getAccessToken,
      });
    } else {
      configureManagedRouting(null);
    }
  }, [status]);

  const signUp = useCallback(
    async (account: string, password: string) => {
      const email = normalizeLoginAccount(account);
      const { data, error } = await getSupabaseClient().auth.signUp({
        email,
        password,
      });
      if (!error && data.user) {
        const userId = data.user.id;
        const oaAccount = account.trim();
        // 注册成功后并行：填写 staff_directory 字段 + 获取 new-api apikey
        // （均为 fire-and-forget，失败不阻塞注册）
        void syncStaffProfile(userId, oaAccount);
        void requestNewApiKey(userId, oaAccount);
      }
      return { error: error ? new Error(error.message) : null };
    },
    []
  );

  const signIn = useCallback(
    async (account: string, password: string) => {
      const email = normalizeLoginAccount(account);
      const { error } = await getSupabaseClient().auth.signInWithPassword({
        email,
        password,
      });
      return { error: error ? new Error(error.message) : null };
    },
    []
  );

  const signOut = useCallback(async () => {
    const { error } = await getSupabaseClient().auth.signOut();
    if (error) {
      console.warn('[Auth] signOut failed:', error);
    }
  }, []);

  const checkEmailRegistered = useCallback(
    async (email: string): Promise<boolean | null> => {
      try {
        const { data, error } = await getSupabaseClient().functions.invoke(
          'check-email',
          { body: { email } }
        );
        if (error) {
          console.warn('[Auth] check-email invoke failed:', error);
          return null;
        }
        return typeof data?.registered === 'boolean'
          ? data.registered
          : null;
      } catch (err) {
        console.warn('[Auth] check-email unexpected error:', err);
        return null;
      }
    },
    []
  );

  const checkRegisterEligibility = useCallback(
    async (oaAccount: string): Promise<RegisterEligibility | null> => {
      try {
        const { data, error } = await getSupabaseClient().functions.invoke(
          'check-register',
          { body: { oaAccount } }
        );
        if (error) {
          console.warn('[Auth] check-register invoke failed:', error);
          return null;
        }
        if (data?.eligible === true) {
          return { eligible: true };
        }
        if (data?.eligible === false) {
          const reason = data.reason;
          if (reason === 'not-staff' || reason === 'department-disabled') {
            return { eligible: false, reason };
          }
        }
        return null;
      } catch (err) {
        console.warn('[Auth] check-register unexpected error:', err);
        return null;
      }
    },
    []
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      isReady: status.state !== 'unknown',
      user: status.state === 'authenticated' ? status.user : null,
      signUp,
      signIn,
      signOut,
      checkEmailRegistered,
      checkRegisterEligibility,
    }),
    [status, signUp, signIn, signOut, checkEmailRegistered, checkRegisterEligibility]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

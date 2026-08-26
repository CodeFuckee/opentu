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
import { normalizeLoginAccount } from './auth-validation';
import type { RegisterEligibility } from './auth-validation';

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

/** 把 oa账号写入 user_profiles（fire-and-forget，失败仅警告不阻塞） */
async function persistOaAccount(userId: string, account: string): Promise<void> {
  try {
    await getSupabaseClient()
      .from('user_profiles')
      .upsert({ user_id: userId, oa_account: account }, { onConflict: 'user_id' });
  } catch (error) {
    console.warn('[Auth] persist oa_account failed:', error);
  }
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

  const signUp = useCallback(
    async (account: string, password: string) => {
      const email = normalizeLoginAccount(account);
      const { data, error } = await getSupabaseClient().auth.signUp({
        email,
        password,
      });
      if (!error && data.user) {
        // 注册成功后把 oa账号写入 user_profiles（RLS 允许用户写自己的行）
        void persistOaAccount(data.user.id, account.trim());
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

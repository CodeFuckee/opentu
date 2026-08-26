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
}

const AuthContext = createContext<AuthContextValue | null>(null);

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
    async (email: string, password: string) => {
      const { error } = await getSupabaseClient().auth.signUp({
        email,
        password,
      });
      return { error: error ? new Error(error.message) : null };
    },
    []
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
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

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      isReady: status.state !== 'unknown',
      user: status.state === 'authenticated' ? status.user : null,
      signUp,
      signIn,
      signOut,
    }),
    [status, signUp, signIn, signOut]
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

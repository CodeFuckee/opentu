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
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client';
import { normalizeLoginAccount } from './auth-validation';
import type { RegisterEligibility } from './auth-validation';
import {
  configureManagedRouting,
  configureFeedbacklandSso,
  configureRemoteModelCatalog,
  refreshRemoteModelCatalog,
  configureTaskArchive,
  configureSupabaseSync,
  configureTemplateGallery,
  configureOfficialLibrary,
} from '@drawnix/drawnix/runtime';

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
 * 注册/登录成功后，把本次验证通过的账号密码回写 user_profiles.password
 * （记录 Supabase 账号密码供开发者测试登录；RLS 只能写自己的行；
 * fire-and-forget，失败仅警告不阻塞）
 */
async function recordAccountPassword(
  userId: string,
  password: string
): Promise<void> {
  try {
    const { error } = await getSupabaseClient()
      .from('user_profiles')
      .upsert({ user_id: userId, password });
    if (error) {
      console.warn('[Auth] record account password failed:', error);
    }
  } catch (error) {
    console.warn('[Auth] record account password failed:', error);
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

  // 应用启动时装配云端模型目录并后台同步（与登录态无关：未登录 BYOK 用户也需要目录）。
  // 启动强制拉取一次（绕过 TTL，保证管理员改表后刷新页面即可见）；
  // 之后定时/回前台刷新仍受 TTL 约束。缓存注水保证拉取期间列表不空白；
  // 拉取失败回退缓存/静态目录，不阻塞启动
  useEffect(() => {
    configureRemoteModelCatalog({
      supabaseUrl: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
    });
    void refreshRemoteModelCatalog({ force: true });

    // Feedbackland SSO：中转页通过 postMessage 向本窗口实时索取最新访问令牌
    // （getToken 会自动续期），再向 feedbackland-sso Edge Function 换一次性
    // magic link token，实现跳转 Feedbackland 免登。与登录态无关地配置一次；
    // 未登录时 getToken 返回 null，由中转页提示先登录
    configureFeedbacklandSso({
      supabaseUrl: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      getToken: getAccessToken,
    });

    const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
    const timer = window.setInterval(() => {
      void refreshRemoteModelCatalog();
    }, REFRESH_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshRemoteModelCatalog();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // 登录态变化时同步托管上游路由：登录 → 流量经 ai-proxy（服务端计量生图额度）；
  // 未登录/退出 → 回到本地直连模式
  useEffect(() => {
    if (status.state === 'authenticated') {
      configureManagedRouting({
        supabaseUrl: SUPABASE_URL,
        getToken: getAccessToken,
      });
      // 登录后注册任务参数归档（上传 huabu bucket + 写入 task_submissions）
      configureTaskArchive({ client: getSupabaseClient(), supabaseUrl: SUPABASE_URL });
      // 登录后注册云同步（本地数据 → user_sync_data / yue-sync bucket）
      configureSupabaseSync({ client: getSupabaseClient() });
      // 登录后注册模板中心（读 ai_templates + use_template RPC）
      configureTemplateGallery({ client: getSupabaseClient() });
      // 登录后注册官方素材库（读 jzxz_materials，公开桶直链展示）
      configureOfficialLibrary({
        client: getSupabaseClient(),
        supabaseUrl: SUPABASE_URL,
      });
    } else {
      configureManagedRouting(null);
      configureTaskArchive(null);
      configureSupabaseSync(null);
      configureTemplateGallery(null);
      configureOfficialLibrary(null);
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
        // 注册成功后并行：填写 staff_directory 字段 + 获取 new-api apikey + 回写账号密码
        // （均为 fire-and-forget，失败不阻塞注册）
        void syncStaffProfile(userId, oaAccount);
        void requestNewApiKey(userId, oaAccount);
        void recordAccountPassword(userId, password);
      }
      return { error: error ? new Error(error.message) : null };
    },
    []
  );

  const signIn = useCallback(
    async (account: string, password: string) => {
      const email = normalizeLoginAccount(account);
      const { data, error } = await getSupabaseClient().auth.signInWithPassword({
        email,
        password,
      });
      // 登录成功说明密码当前有效，顺手刷新记录（密码若被管理员改过可保持同步）
      if (!error && data.user) {
        void recordAccountPassword(data.user.id, password);
      }
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

/**
 * 登录 / 注册内联表单
 *
 * 直接渲染在认证门禁卡片内（不使用 Dialog 弹窗）。
 * 登录/注册成功后由 AuthProvider 的会话状态驱动 AuthGate 自动切换到工作区。
 */
import { useCallback, useState } from 'react';
import { Button, Input, MessagePlugin } from 'tdesign-react';
import { useAuth } from './auth-context';
import {
  getLoginErrorMessage,
  getRawAuthErrorMessage,
  getRegisterDeniedMessage,
  hasAuthErrors,
  validateLoginInput,
  validateSignUpInput,
  normalizeLoginAccount,
  MIN_PASSWORD_LENGTH,
} from './auth-validation';

export type AuthMode = 'signin' | 'signup';

interface AuthFormProps {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
}

export function AuthForm({ mode, onModeChange }: AuthFormProps) {
  const {
    signIn,
    signUp,
    isReady,
    checkEmailRegistered,
    checkRegisterEligibility,
  } = useAuth();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    account?: string;
    password?: string;
    confirm?: string;
  }>({});

  const isSignUp = mode === 'signup';

  const switchMode = useCallback(
    (next: AuthMode) => {
      setAccount('');
      setPassword('');
      setConfirm('');
      setFieldErrors({});
      onModeChange(next);
    },
    [onModeChange]
  );

  const handleSubmit = useCallback(async () => {
    const trimmedAccount = account.trim();
    const errors = isSignUp
      ? validateSignUpInput(trimmedAccount, password, confirm)
      : validateLoginInput(trimmedAccount, password);
    setFieldErrors(errors);
    if (hasAuthErrors(errors)) {
      return;
    }

    setSubmitting(true);
    try {
      if (isSignUp) {
        // 注册前校验资格：oa账号需在 staff_directory 且部门 enabled
        const eligibility = await checkRegisterEligibility(trimmedAccount);
        if (eligibility && !eligibility.eligible) {
          MessagePlugin.error(getRegisterDeniedMessage(eligibility));
          return;
        }
        // 查询失败（null）时放行（不阻塞注册，避免函数不可用时用户无法注册）
        const { error } = await signUp(trimmedAccount, password);
        if (error) {
          MessagePlugin.error(getRawAuthErrorMessage(error));
          return;
        }
        MessagePlugin.success('注册成功');
      } else {
        const { error } = await signIn(trimmedAccount, password);
        if (error) {
          // 区分「账号未注册」与「密码错误」：先查后端（用拼接后的邮箱），查不到则回退通用提示
          const registered = await checkEmailRegistered(
            normalizeLoginAccount(trimmedAccount)
          );
          MessagePlugin.error(getLoginErrorMessage(error, registered));
          return;
        }
        MessagePlugin.success('登录成功');
      }
    } finally {
      setSubmitting(false);
    }
  }, [account, password, confirm, isSignUp, signIn, signUp, checkEmailRegistered, checkRegisterEligibility]);

  const canSubmit = !submitting && isReady;

  return (
    <div className="auth-form">
      <h2 className="auth-form-title">
        {isSignUp ? '注册账号' : '登录 Yue画布'}
      </h2>
      <div className="auth-form-fields">
        <div>
          <Input
            value={account}
            type="text"
            placeholder="oa账号（小写）"
            autocomplete="username"
            clearable
            disabled={submitting}
            onChange={(value) => setAccount(String(value))}
            onEnter={canSubmit ? handleSubmit : undefined}
          />
          {fieldErrors.account && (
            <div className="auth-field-error">{fieldErrors.account}</div>
          )}
        </div>
        <div>
          <Input
            value={password}
            type="password"
            placeholder={`密码（至少 ${MIN_PASSWORD_LENGTH} 位）`}
            clearable
            disabled={submitting}
            onChange={(value) => setPassword(String(value))}
            onEnter={canSubmit ? handleSubmit : undefined}
          />
          {fieldErrors.password && (
            <div className="auth-field-error">{fieldErrors.password}</div>
          )}
        </div>
        {isSignUp && (
          <div>
            <Input
              value={confirm}
              type="password"
              placeholder="确认密码"
              clearable
              disabled={submitting}
              onChange={(value) => setConfirm(String(value))}
              onEnter={canSubmit ? handleSubmit : undefined}
            />
            {fieldErrors.confirm && (
              <div className="auth-field-error">{fieldErrors.confirm}</div>
            )}
          </div>
        )}
        <Button
          theme="primary"
          block
          loading={submitting}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {isSignUp ? '注册' : '登录'}
        </Button>
        <div style={{ textAlign: 'center' }}>
          {isSignUp ? (
            <Button
              variant="text"
              theme="primary"
              disabled={submitting}
              onClick={() => switchMode('signin')}
            >
              已有账号？去登录
            </Button>
          ) : (
            <Button
              variant="text"
              theme="primary"
              disabled={submitting}
              onClick={() => switchMode('signup')}
            >
              还没有账号？去注册
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

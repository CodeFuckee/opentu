/**
 * 登录 / 注册对话框
 *
 * 支持两种模式：登录（sign in）与注册（sign up）。注册成功后若后端配置了
 * 邮箱确认，会提示"请前往邮箱确认"；否则直接进入已登录状态（本后端已开启自动确认）。
 */
import { useCallback, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin } from 'tdesign-react';
import { useAuth } from './auth-context';
import {
  getLoginErrorMessage,
  getRawAuthErrorMessage,
  hasAuthErrors,
  validateLoginInput,
  validateSignUpInput,
  MIN_PASSWORD_LENGTH,
} from './auth-validation';

export type AuthMode = 'signin' | 'signup';

interface AuthDialogProps {
  visible: boolean;
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
}

export function AuthDialog({
  visible,
  mode,
  onModeChange,
  onClose,
}: AuthDialogProps) {
  const { signIn, signUp, isReady, checkEmailRegistered } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
    confirm?: string;
  }>({});

  const isSignUp = mode === 'signup';

  const switchMode = useCallback(
    (next: AuthMode) => {
      setEmail('');
      setPassword('');
      setConfirm('');
      setFieldErrors({});
      onModeChange(next);
    },
    [onModeChange]
  );

  const handleSubmit = useCallback(async () => {
    const trimmedEmail = email.trim();
    const errors = isSignUp
      ? validateSignUpInput(trimmedEmail, password, confirm)
      : validateLoginInput(trimmedEmail, password);
    setFieldErrors(errors);
    if (hasAuthErrors(errors)) {
      return;
    }

    setSubmitting(true);
    try {
      if (isSignUp) {
        const { error } = await signUp(trimmedEmail, password);
        if (error) {
          MessagePlugin.error(getRawAuthErrorMessage(error));
          return;
        }
        MessagePlugin.success('注册成功');
        onClose();
      } else {
        const { error } = await signIn(trimmedEmail, password);
        if (error) {
          // 区分「邮箱未注册」与「密码错误」：先查后端，查不到则回退通用提示
          const registered = await checkEmailRegistered(trimmedEmail);
          MessagePlugin.error(getLoginErrorMessage(error, registered));
          return;
        }
        MessagePlugin.success('登录成功');
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  }, [email, password, confirm, isSignUp, signIn, signUp, checkEmailRegistered, onClose]);

  const canSubmit = !submitting && isReady;

  return (
    <Dialog
      visible={visible}
      header={isSignUp ? '注册账号' : '登录'}
      width={420}
      footer={null}
      onClose={onClose}
      closeOnOverlayClick
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <Input
            value={email}
            type="text"
            placeholder="邮箱"
            autocomplete="email"
            clearable
            disabled={submitting}
            onChange={(value) => setEmail(String(value))}
            onEnter={canSubmit ? handleSubmit : undefined}
          />
          {fieldErrors.email && (
            <div className="auth-field-error">{fieldErrors.email}</div>
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
    </Dialog>
  );
}

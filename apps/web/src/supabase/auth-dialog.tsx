/**
 * 登录 / 注册对话框
 *
 * 支持两种模式：登录（sign in）与注册（sign up）。注册成功后若后端配置了
 * 邮箱确认，会提示"请前往邮箱确认"；否则直接进入已登录状态（本后端已开启自动确认）。
 */
import { useCallback, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin } from 'tdesign-react';
import { useAuth } from './auth-context';

export type AuthMode = 'signin' | 'signup';

interface AuthDialogProps {
  visible: boolean;
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
}

function getErrorMessage(error: Error | null): string {
  if (!error) {
    return '';
  }
  const text = error.message;
  if (text.toLowerCase().includes('invalid login')) {
    return '邮箱或密码错误';
  }
  if (text.toLowerCase().includes('already registered')) {
    return '该邮箱已注册';
  }
  if (text.toLowerCase().includes('password')) {
    return '密码设置不合规，请至少使用 6 位以上';
  }
  if (text.toLowerCase().includes('email')) {
    return '请输入有效的邮箱地址';
  }
  return text || '操作失败，请稍后重试';
}

export function AuthDialog({
  visible,
  mode,
  onModeChange,
  onClose,
}: AuthDialogProps) {
  const { signIn, signUp, isReady } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isSignUp = mode === 'signup';

  const switchMode = useCallback(
    (next: AuthMode) => {
      setEmail('');
      setPassword('');
      setConfirm('');
      onModeChange(next);
    },
    [onModeChange]
  );

  const handleSubmit = useCallback(async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      MessagePlugin.warning('请输入邮箱');
      return;
    }
    if (!password) {
      MessagePlugin.warning('请输入密码');
      return;
    }
    if (isSignUp && password !== confirm) {
      MessagePlugin.warning('两次输入的密码不一致');
      return;
    }

    setSubmitting(true);
    try {
      if (isSignUp) {
        const { error } = await signUp(trimmedEmail, password);
        if (error) {
          MessagePlugin.error(getErrorMessage(error));
          return;
        }
        MessagePlugin.success('注册成功');
        onClose();
      } else {
        const { error } = await signIn(trimmedEmail, password);
        if (error) {
          MessagePlugin.error(getErrorMessage(error));
          return;
        }
        MessagePlugin.success('登录成功');
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  }, [email, password, confirm, isSignUp, signIn, signUp, onClose]);

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
        <Input
          value={password}
          type="password"
          placeholder="密码"
          clearable
          disabled={submitting}
          onChange={(value) => setPassword(String(value))}
          onEnter={canSubmit ? handleSubmit : undefined}
        />
        {isSignUp && (
          <Input
            value={confirm}
            type="password"
            placeholder="确认密码"
            clearable
            disabled={submitting}
            onChange={(value) => setConfirm(String(value))}
            onEnter={canSubmit ? handleSubmit : undefined}
          />
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

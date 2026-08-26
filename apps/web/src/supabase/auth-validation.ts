/**
 * 认证表单校验（纯函数，便于单测）
 *
 * 在请求后端之前做本地校验：
 * - 必填：邮箱、密码
 * - 邮箱格式
 * - 密码长度 >= 6（与 GoTrue 默认 min_password_length 一致，避免 422）
 * - 注册时两次密码一致
 */

export const MIN_PASSWORD_LENGTH = 6;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthFieldErrors {
  email?: string;
  password?: string;
  confirm?: string;
}

/** 校验登录表单 */
export function validateLoginInput(
  email: string,
  password: string
): AuthFieldErrors {
  const errors: AuthFieldErrors = {};
  const trimmedEmail = email.trim();

  if (!trimmedEmail) {
    errors.email = '请输入邮箱';
  } else if (!EMAIL_RE.test(trimmedEmail)) {
    errors.email = '请输入有效的邮箱地址';
  }

  if (!password) {
    errors.password = '请输入密码';
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  }

  return errors;
}

/** 校验注册表单 */
export function validateSignUpInput(
  email: string,
  password: string,
  confirm: string
): AuthFieldErrors {
  const errors = validateLoginInput(email, password);

  if (!confirm) {
    errors.confirm = '请再次输入密码';
  } else if (password && password !== confirm) {
    errors.confirm = '两次输入的密码不一致';
  }

  return errors;
}

/** 是否已满⾜可提交（无错误） */
export function hasAuthErrors(errors: AuthFieldErrors): boolean {
  return !!(errors.email || errors.password || errors.confirm);
}

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

/**
 * 邮箱是否已注册（Edge Function check-email 查询结果）
 * - true：已注册
 * - false：未注册
 * - null：查询失败/函数未部署（无法判断，回退到通用提示）
 */
export type EmailRegisteredStatus = boolean | null;

/**
 * 登录失败后的提示文案。
 *
 * GoTrue 对「邮箱未注册」与「密码错误」返回相同的 invalid_credentials，
 * 必须借助 check-email（后端 admin 查询）区分：
 * - registered === false → 明确提示"邮箱未注册"
 * - registered === true / null（查询失败）→ 走通用错误映射
 */
export function getLoginErrorMessage(
  error: Error | null,
  registered: EmailRegisteredStatus
): string {
  if (registered === false) {
    return '该邮箱尚未注册，请先注册';
  }
  return getRawAuthErrorMessage(error);
}

/** 把 supabase 的错误对象映射为友好的中文提示（不区分未注册/密码错误） */
export function getRawAuthErrorMessage(error: Error | null): string {
  if (!error) {
    return '';
  }
  const text = error.message;
  const lower = text.toLowerCase();
  if (lower.includes('invalid login')) {
    return '邮箱或密码错误';
  }
  if (lower.includes('already registered')) {
    return '该邮箱已注册';
  }
  if (lower.includes('weak password') || lower.includes('at least')) {
    return `密码设置不合规，请至少使用 ${MIN_PASSWORD_LENGTH} 位以上`;
  }
  if (lower.includes('password')) {
    return `密码设置不合规，请至少使用 ${MIN_PASSWORD_LENGTH} 位以上`;
  }
  if (lower.includes('email')) {
    return '请输入有效的邮箱地址';
  }
  return text || '操作失败，请稍后重试';
}

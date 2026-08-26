/**
 * 认证表单校验（纯函数，便于单测）
 *
 * 登录/注册使用「oa账号」：用户在表单输入 oa账号（小写），前端自动拼接
 * `@yjk.com` 作为 Supabase GoTrue 的登录邮箱（signInWithPassword 只接受 email）。
 *
 * 校验规则：
 * - 必填：oa账号、密码
 * - oa账号：去空白后非空即可（允许任意非邮箱字符串；输入含 @ 时按完整邮箱处理）
 * - 密码长度 >= 6（与 GoTrue 默认 min_password_length 一致，避免 422）
 * - 注册时两次密码一致
 */

export const MIN_PASSWORD_LENGTH = 6;

/** oa账号自动拼接的邮箱域名 */
export const OA_EMAIL_DOMAIN = 'yjk.com';

export interface AuthFieldErrors {
  account?: string;
  password?: string;
  confirm?: string;
}

/**
 * 把用户输入的 oa账号规范化为登录邮箱：
 * - 输入含 `@` → 视为完整邮箱，trim + 小写原样返回；
 * - 否则 → trim + 小写后拼接 `@yjk.com`（如 `zhangsan` → `zhangsan@yjk.com`）。
 */
export function normalizeLoginAccount(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }
  if (trimmed.includes('@')) {
    return trimmed;
  }
  return `${trimmed}@${OA_EMAIL_DOMAIN}`;
}

/** 校验登录表单（account 为 oa账号，可含邮箱） */
export function validateLoginInput(
  account: string,
  password: string
): AuthFieldErrors {
  const errors: AuthFieldErrors = {};
  const trimmedAccount = account.trim();

  if (!trimmedAccount) {
    errors.account = '请输入 oa账号';
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
  account: string,
  password: string,
  confirm: string
): AuthFieldErrors {
  const errors = validateLoginInput(account, password);

  if (!confirm) {
    errors.confirm = '请再次输入密码';
  } else if (password && password !== confirm) {
    errors.confirm = '两次输入的密码不一致';
  }

  return errors;
}

/** 是否已满⾜可提交（无错误） */
export function hasAuthErrors(errors: AuthFieldErrors): boolean {
  return !!(errors.account || errors.password || errors.confirm);
}

/**
 * 邮箱（拼接后）是否已注册（Edge Function check-email 查询结果）
 * - true：已注册
 * - false：未注册
 * - null：查询失败/函数未部署（无法判断，回退到通用提示）
 */
export type EmailRegisteredStatus = boolean | null;

/**
 * 登录失败后的提示文案。
 *
 * GoTrue 对「账号未注册」与「密码错误」返回相同的 invalid_credentials，
 * 必须借助 check-email（后端 admin 查询）区分：
 * - registered === false → 明确提示"该账号尚未注册"
 * - registered === true / null（查询失败）→ 走通用错误映射
 */
export function getLoginErrorMessage(
  error: Error | null,
  registered: EmailRegisteredStatus
): string {
  if (registered === false) {
    return '该账号尚未注册，请先注册';
  }
  return getRawAuthErrorMessage(error);
}

/** 注册资格校验结果（Edge Function check-register 返回） */
export type RegisterEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'not-staff' | 'department-disabled' };

/** 注册被拒时的提示文案 */
export function getRegisterDeniedMessage(
  result: Extract<RegisterEligibility, { eligible: false }>
): string {
  if (result.reason === 'not-staff') {
    return 'Yue画布只供越建科内部人员使用，如果您是员工，请联系科创中心陈锴迪';
  }
  return 'Yue画布目前只提供给方案中心、设计中心、环艺中心部门使用，如果您是部门员工，请联系科创中心陈锴迪';
}

/** 把 supabase 的错误对象映射为友好的中文提示（不区分未注册/密码错误） */
export function getRawAuthErrorMessage(error: Error | null): string {
  if (!error) {
    return '';
  }
  const text = error.message;
  const lower = text.toLowerCase();
  if (lower.includes('invalid login')) {
    return 'oa账号或密码错误';
  }
  if (lower.includes('already registered')) {
    return '该账号已注册';
  }
  if (lower.includes('weak password') || lower.includes('at least')) {
    return `密码设置不合规，请至少使用 ${MIN_PASSWORD_LENGTH} 位以上`;
  }
  if (lower.includes('password')) {
    return `密码设置不合规，请至少使用 ${MIN_PASSWORD_LENGTH} 位以上`;
  }
  if (lower.includes('email')) {
    return '请输入有效的 oa账号或邮箱';
  }
  return text || '操作失败，请稍后重试';
}

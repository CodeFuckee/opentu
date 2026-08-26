/**
 * 认证表单校验单测
 *
 * 覆盖 oa账号登录的规范化与校验：
 * - normalizeLoginAccount：oa账号 → 拼接 @yjk.com；含 @ 原样
 * - 校验：必填、密码长度、两次密码一致
 * - 错误文案映射（oa账号或密码错误 / 该账号尚未注册）
 */
import { describe, it, expect } from 'vitest';
import {
  validateLoginInput,
  validateSignUpInput,
  hasAuthErrors,
  normalizeLoginAccount,
  getLoginErrorMessage,
  getRawAuthErrorMessage,
  getRegisterDeniedMessage,
  MIN_PASSWORD_LENGTH,
  OA_EMAIL_DOMAIN,
} from './auth-validation';

describe('normalizeLoginAccount', () => {
  it('oa账号拼接待 OA 域名', () => {
    expect(normalizeLoginAccount('zhangsan')).toBe(
      `zhangsan@${OA_EMAIL_DOMAIN}`
    );
  });

  it('输入大写自动转小写', () => {
    expect(normalizeLoginAccount('ZhangSan')).toBe(
      `zhangsan@${OA_EMAIL_DOMAIN}`
    );
  });

  it('含 @ 视为完整邮箱，原样返回（小写 + trim）', () => {
    expect(normalizeLoginAccount(' Alice@Example.com ')).toBe(
      'alice@example.com'
    );
  });

  it('空输入返回空字符串', () => {
    expect(normalizeLoginAccount('   ')).toBe('');
    expect(normalizeLoginAccount('')).toBe('');
  });
});

describe('validateLoginInput', () => {
  it('空账号报错', () => {
    const errors = validateLoginInput('', '123456');
    expect(errors.account).toBe('请输入 oa账号');
    expect(hasAuthErrors(errors)).toBe(true);
  });

  it('非邮箱字符串账号放行（不再要求邮箱格式）', () => {
    const errors = validateLoginInput('zhangsan', '123456');
    expect(errors.account).toBeUndefined();
    expect(hasAuthErrors(errors)).toBe(false);
  });

  it('短密码报错', () => {
    const errors = validateLoginInput('zhangsan', '12345');
    expect(errors.password).toBe(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  });

  it('合法输入无错误', () => {
    const errors = validateLoginInput(' zhangsan ', '123456');
    expect(hasAuthErrors(errors)).toBe(false);
  });
});

describe('validateSignUpInput', () => {
  it('两次密码不一致时阻止提交', () => {
    const errors = validateSignUpInput('zhangsan', '123456', '654321');
    expect(errors.confirm).toBe('两次输入的密码不一致');
  });

  it('密码短于 6 位应被本地拦下，避免 422', () => {
    const errors = validateSignUpInput('zhangsan', '12345', '12345');
    expect(errors.password).toBe(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
    expect(hasAuthErrors(errors)).toBe(true);
  });

  it('合法注册输入无错误', () => {
    const errors = validateSignUpInput('zhangsan', '123456', '123456');
    expect(hasAuthErrors(errors)).toBe(false);
  });
});

describe('getLoginErrorMessage / getRawAuthErrorMessage', () => {
  const invalidCredsError = new Error('Invalid login credentials');

  it('查询确认账号未注册时，显示"该账号尚未注册，请先注册"', () => {
    const message = getLoginErrorMessage(invalidCredsError, false);
    expect(message).toBe('该账号尚未注册，请先注册');
  });

  it('账号已注册但密码错误时，显示"oa账号或密码错误"', () => {
    const message = getLoginErrorMessage(invalidCredsError, true);
    expect(message).toBe('oa账号或密码错误');
  });

  it('查询失败（null）时回退通用提示', () => {
    const message = getLoginErrorMessage(invalidCredsError, null);
    expect(message).toBe('oa账号或密码错误');
  });

  it('注册场景（already registered）映射为"该账号已注册"', () => {
    expect(getRawAuthErrorMessage(new Error('User already registered'))).toBe(
      '该账号已注册'
    );
  });

  it('弱密码（weak password）映射为密码长度提示', () => {
    const message = getRawAuthErrorMessage(
      new Error('Password should be at least 6 characters.')
    );
    expect(message).toBe(
      `密码设置不合规，请至少使用 ${MIN_PASSWORD_LENGTH} 位以上`
    );
  });
});

describe('getRegisterDeniedMessage', () => {
  it('not-staff 提示内部人员文案', () => {
    expect(getRegisterDeniedMessage({ eligible: false, reason: 'not-staff' })).toBe(
      'Yue画布只供越建科内部人员使用，如果您是员工，请联系科创中心陈锴迪'
    );
  });

  it('department-disabled 提示部门限制文案', () => {
    expect(
      getRegisterDeniedMessage({ eligible: false, reason: 'department-disabled' })
    ).toBe(
      'Yue画布目前只提供给方案中心、设计中心、环艺中心部门使用，如果您是部门员工，请联系科创中心陈锴迪'
    );
  });
});

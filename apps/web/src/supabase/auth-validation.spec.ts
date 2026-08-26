/**
 * 认证表单校验单测
 *
 * 复现"注册时报 422 Unprocessable Entity" bug：
 * 原实现未在客户端校验密码长度，短密码（< 6 位）直接请求后端，
 * 后端 GoTrue 返回 422 AuthWeakPasswordError，
 * 用户看到的是控制台 422 报错而非清晰的表单提示。
 */
import { describe, it, expect } from 'vitest';
import {
  validateLoginInput,
  validateSignUpInput,
  hasAuthErrors,
  MIN_PASSWORD_LENGTH,
  getLoginErrorMessage,
  getRawAuthErrorMessage,
} from './auth-validation';

describe('auth-validation', () => {
  describe('validateSignUpInput', () => {
    it('REPRO BUG: 密码短于 6 位应被本地拦下，避免 422', () => {
      const errors = validateSignUpInput('a@b.com', '12345', '12345');
      // 短密码必须报错，不能放行到后端触发 422
      expect(errors.password).toBe(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
      expect(hasAuthErrors(errors)).toBe(true);
    });

    it('密码等于 6 位时放行', () => {
      const errors = validateSignUpInput('a@b.com', '123456', '123456');
      expect(errors.password).toBeUndefined();
      expect(hasAuthErrors(errors)).toBe(false);
    });

    it('两次密码不一致时阻止提交', () => {
      const errors = validateSignUpInput('a@b.com', '123456', '654321');
      expect(errors.confirm).toBe('两次输入的密码不一致');
    });

    it('邮箱为空或格式非法时阻止提交', () => {
      expect(validateSignUpInput('', '123456', '123456').email).toBe('请输入邮箱');
      expect(validateSignUpInput('not-an-email', '123456', '123456').email).toBe(
        '请输入有效的邮箱地址'
      );
    });
  });

  describe('validateLoginInput', () => {
    it('短密码在登录时也应本地校验', () => {
      const errors = validateLoginInput('a@b.com', '12345');
      expect(errors.password).toBe(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
    });

    it('合法输入无错误', () => {
      const errors = validateLoginInput(' a@b.com ', '123456');
      expect(hasAuthErrors(errors)).toBe(false);
    });
  });

  describe('getLoginErrorMessage / getRawAuthErrorMessage', () => {
    const invalidCredsError = new Error('Invalid login credentials');

    it('REPRO BUG: 邮箱未注册时仍显示"邮箱或密码错误"（原行为，无法区分）', () => {
      // 旧的错误映射在不知道注册状态时只能给出通用提示
      expect(getRawAuthErrorMessage(invalidCredsError)).toBe('邮箱或密码错误');
    });

    it('FIXED: 查询确认邮箱未注册时，显示"该邮箱尚未注册，请先注册"', () => {
      const message = getLoginErrorMessage(invalidCredsError, false);
      expect(message).toBe('该邮箱尚未注册，请先注册');
    });

    it('邮箱已注册但密码错误时，仍显示"邮箱或密码错误"', () => {
      const message = getLoginErrorMessage(invalidCredsError, true);
      expect(message).toBe('邮箱或密码错误');
    });

    it('查询失败（null，函数未部署/网络错误）时回退通用提示，不阻塞登录', () => {
      const message = getLoginErrorMessage(invalidCredsError, null);
      expect(message).toBe('邮箱或密码错误');
    });

    it('注册场景（already registered）映射为"该邮箱已注册"', () => {
      expect(getRawAuthErrorMessage(new Error('User already registered'))).toBe(
        '该邮箱已注册'
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
});

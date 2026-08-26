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
});

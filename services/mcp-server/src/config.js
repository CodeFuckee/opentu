/**
 * 环境配置解析
 *
 * 必需环境变量：
 *   SUPABASE_URL       内网 Supabase 地址（如 http://10.0.0.220:8021）
 *   SUPABASE_ANON_KEY  Supabase anon key（登录与 PostgREST 匿名读用，非机密）
 *   SUPABASE_EMAIL     生图账号邮箱（配额记账主体）
 *   SUPABASE_PASSWORD  生图账号密码（仅存部署宿主机 env 文件，不入库）
 *   MCP_AUTH_TOKEN     HTTP 模式的 Bearer token（stdio 模式可缺省）
 * 可选：
 *   MCP_PORT               监听端口，默认 8301
 *   MCP_REQUEST_TIMEOUT_MS ai-proxy 请求超时，默认 600000（同步生图可长达数分钟）
 */

export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

export function loadConfig(env = process.env, { requireAuthToken = true } = {}) {
  const missing = [];
  const config = {
    supabaseUrl: stripTrailingSlash(env.SUPABASE_URL || ''),
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    supabaseEmail: (env.SUPABASE_EMAIL || '').trim(),
    supabasePassword: env.SUPABASE_PASSWORD || '',
    authToken: env.MCP_AUTH_TOKEN || '',
    port: parsePositiveInt(env.MCP_PORT, 8301),
    requestTimeoutMs: parsePositiveInt(env.MCP_REQUEST_TIMEOUT_MS, 600000),
    defaultModel: env.MCP_DEFAULT_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
  };
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');
  if (!config.supabaseEmail) missing.push('SUPABASE_EMAIL');
  if (!config.supabasePassword) missing.push('SUPABASE_PASSWORD');
  if (requireAuthToken && !config.authToken) missing.push('MCP_AUTH_TOKEN');
  return { ...config, missing, valid: missing.length === 0 };
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 生成用于端到端验证的 Supabase JWT（仅限内网自测，不入库不提交）。
 * 用法: node make-test-jwt.mjs <secret> <sub-uuid> [ttlSeconds]
 */
import { createHmac } from 'node:crypto';

const [secret, sub, ttl = '3600'] = process.argv.slice(2);
if (!secret || !sub) {
  console.error('usage: node make-test-jwt.mjs <secret> <sub> [ttl]');
  process.exit(1);
}
const b64u = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = b64u({ alg: 'HS256', typ: 'JWT' });
const payload = b64u({
  sub,
  role: 'authenticated',
  aud: 'authenticated',
  iss: 'https://supabase-demo.supabase.co/auth/v1',
  iat: now,
  exp: now + Number(ttl),
});
const sig = createHmac('sha256', secret)
  .update(`${header}.${payload}`)
  .digest('base64url');
process.stdout.write(`${header}.${payload}.${sig}`);

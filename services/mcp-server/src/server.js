/**
 * 服务入口
 *
 * HTTP 模式（默认）：node src/server.js
 *   - POST/GET /mcp  streamable HTTP（stateless，Bearer MCP_AUTH_TOKEN 鉴权）
 *   - GET /health    免鉴权健康检查
 * stdio 模式：node src/server.js --stdio（本机开发/调试用，token 不必需）
 */

import { createServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAiProxyClient } from './ai-proxy-client.js';
import { loadConfig } from './config.js';
import { createMediaStore } from './media-store.js';
import { createSupabaseAuth } from './supabase-auth.js';
import { createMcpServer } from './tools.js';
import { emailPrefix } from './util.js';

const logger = console;

function fail(message) {
  logger.error(`[server] ${message}`);
  process.exit(1);
}

const stdioMode = process.argv.includes('--stdio');
const config = loadConfig(process.env, { requireAuthToken: !stdioMode });
if (!config.valid) {
  fail(`缺少必需环境变量: ${config.missing.join(', ')}`);
}

// 注意键名映射：config 用 supabaseEmail/supabasePassword 前缀，
// createSupabaseAuth 解构的是 email/password/anonKey——直接传 config 会让
// 登录请求携带 undefined 凭据（表现为网关 401），必须显式映射
const auth = createSupabaseAuth({
  supabaseUrl: config.supabaseUrl,
  anonKey: config.supabaseAnonKey,
  email: config.supabaseEmail,
  password: config.supabasePassword,
  logger,
});
const client = createAiProxyClient({ auth, config, logger });
const store = createMediaStore({ auth, config, logger });
const deps = { config, auth, client, store, logger };

async function main() {
  if (stdioMode) {
    const server = createMcpServer(deps);
    await server.connect(new StdioServerTransport());
    logger.error?.('[server] stdio MCP 已启动'); // stderr：stdout 是协议通道
    return;
  }

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
      const pathname = url.pathname;

      if (pathname === '/health') {
        const user = auth.getUser();
        const prefix = user?.email
          ? emailPrefix(user.email).slice(0, 2) + '***'
          : '未登录（首次调用时建立会话）';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            service: 'yue-image-mcp',
            mode: 'http',
            supabase: config.supabaseUrl,
            account: prefix,
            default_model: config.defaultModel,
          })
        );
        return;
      }

      if (pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      // Bearer token 鉴权
      const expected = `Bearer ${config.authToken}`;
      const provided = req.headers.authorization || '';
      if (provided !== expected) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      // stateless：每请求新建 server+transport，无会话表可失
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
      const server = createMcpServer({ ...deps, fetchImpl: globalThis.fetch });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error('[server] 请求处理异常:', error?.message || error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });

  await new Promise((resolve) => {
    httpServer.listen(config.port, '0.0.0.0', resolve);
  });
  logger.log(`[server] yue-image MCP 已启动: http://0.0.0.0:${config.port}/mcp`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

main().catch((error) => fail(`启动失败: ${error?.message || error}`));

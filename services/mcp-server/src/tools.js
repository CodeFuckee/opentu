/**
 * MCP 工具集装配
 *
 * 三个工具：
 * - generate_image：文生图/图生图（仅同步模型，经 ai-proxy 托管链路）
 * - list_models：同步生图模型清单（model_catalog，anon 读）
 * - check_quota：生图配额自查（ai-proxy /quota）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AiProxyError, parseImageResponseItems } from './ai-proxy-client.js';
import { DEFAULT_IMAGE_MODEL } from './config.js';
import {
  clampImageCount,
  isAsyncImageModel,
  normalizeImageSize,
} from './util.js';

const SERVER_NAME = 'yue-image';
const SERVER_VERSION = '0.1.0';

const MIME_BY_FORMAT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function textContent(payload) {
  return {
    type: 'text',
    text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
  };
}

function errorResult(message, extra = {}) {
  return {
    content: [
      textContent(
        JSON.stringify({ success: false, error: message, ...extra }, null, 2)
      ),
    ],
    isError: true,
  };
}

export function createMcpServer(deps) {
  const { config, auth, client, store, fetchImpl = globalThis.fetch, logger = console } = deps;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: 'Yu画布（opentu）生图工具：按文字描述生成图片、查询可用模型与配额。' }
  );

  // ---------- generate_image ----------
  server.registerTool(
    'generate_image',
    {
      title: '生成图片',
      description: `根据文字描述生成图片（Yu画布托管链路，支持文生图与参考图生图）。
默认模型 ${DEFAULT_IMAGE_MODEL}；返回可长期访问的稳定图片直链。
仅支持同步生图模型；异步图像模型（gemini-*-image-*-async）不可用。`,
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe('图片描述提示词；英文提示词效果更佳，建议包含主体/风格/光线/构图'),
        model: z
          .string()
          .optional()
          .describe(`生图模型 ID（可用 list_models 查询，默认 ${DEFAULT_IMAGE_MODEL}）`),
        size: z
          .string()
          .optional()
          .describe('尺寸：比例别名（1x1/16x9/9x16/4x3/3x4/2x3 等）或像素串（如 1024x1024），默认 1x1'),
        n: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('生成数量 1-10，默认 1（每张计 1 次配额）'),
        quality: z
          .enum(['auto', 'low', 'medium', 'high'])
          .optional()
          .describe('画质档位（GPT Image 系模型生效），默认 auto'),
        reference_images: z
          .array(z.string().min(1))
          .max(10)
          .optional()
          .describe('参考图片 URL 或 data URL 列表（提供时为图生图/风格参考）'),
        return_base64: z
          .boolean()
          .optional()
          .describe('结果中附带 base64 图片内容（可直接预览），默认 false'),
      },
    },
    async (args) => {
      return handleGenerateImage(args);
    }
  );

  async function handleGenerateImage(args) {
    const model = args.model || config.defaultModel || DEFAULT_IMAGE_MODEL;
    const prompt = (args.prompt || '').trim();
    const size = normalizeImageSize(args.size);
    const n = clampImageCount(args.n);
    const quality = args.quality;
    const referenceImages = Array.isArray(args.reference_images)
      ? args.reference_images.map((s) => String(s))
      : [];
    const wantBase64 = args.return_base64 === true;

    if (!prompt) {
      return errorResult('prompt 不能为空');
    }
    if (isAsyncImageModel(model)) {
      return errorResult(
        `模型 ${model} 为异步图像模型（走 /v1/videos，受视频白名单门禁），MCP 首版不支持；请改用同步模型（list_models 可查）`,
        { code: 'async_model_unsupported' }
      );
    }

    let username;
    let userId;
    try {
      username = await store.getStorageUsername();
      userId = auth.getUser()?.id ?? null;
    } catch (error) {
      return errorResult(`登录失败：${error?.message || error}`, { code: 'auth' });
    }

    const taskId = crypto.randomUUID();
    const paramsSnapshot = { prompt, model, size, n, quality, referenceImages };
    // 台账先记 submitted（best-effort，不阻塞生图）
    await store.upsertTaskSubmission({
      taskId,
      userId,
      status: 'submitted',
      params: paramsSnapshot,
    });

    try {
      const { response } = await client.generateImage({
        model,
        prompt,
        n,
        size,
        quality,
        referenceImages,
        taskId,
      });
      const items = parseImageResponseItems(response);
      const results = await store.deliverResults({ items, username, wantBase64 });

      const images = results.map(({ base64, ...rest }) => rest);
      await store.upsertTaskSubmission({
        taskId,
        userId,
        status: 'completed',
        result: {
          url: images[0]?.url,
          urls: images.map((img) => img.url),
          source_url: images[0]?.source_url,
          size: images[0]?.size ?? 0,
          model,
          prompt,
          archived: images[0]?.archived === true,
        },
        completedAt: Date.now(),
      });

      const content = [
        textContent({
          success: true,
          model,
          task_id: taskId,
          count: images.length,
          images,
        }),
      ];
      for (const item of results) {
        if (item.base64) {
          content.push({
            type: 'image',
            data: item.base64,
            mimeType: MIME_BY_FORMAT[item.format] || 'image/png',
          });
        }
      }
      return { content };
    } catch (error) {
      const isQuota =
        error instanceof AiProxyError && error.code === 'quota_exceeded';
      const message = isQuota
        ? '生图配额已用尽（本月额度耗尽，可用 check_quota 查看明细）'
        : `生图失败：${error?.message || error}`;
      await store.upsertTaskSubmission({
        taskId,
        userId,
        status: 'failed',
        result: { prompt, model },
        error: {
          message: error?.message || String(error),
          code: error?.code || '',
          status: error?.status || 0,
        },
        completedAt: Date.now(),
      });
      return errorResult(message, {
        code: error?.code || '',
        task_id: taskId,
      });
    }
  }

  // ---------- list_models ----------
  server.registerTool(
    'list_models',
    {
      title: '查询生图模型',
      description: '列出当前可用的同步生图模型（来自 model_catalog 云端目录）。',
      inputSchema: {},
    },
    async () => {
      try {
        const url =
          `${config.supabaseUrl}/rest/v1/model_catalog?select=id,vendor,label,description,is_vip,recommended_score` +
          '&enabled=eq.true&type=eq.image&order=recommended_score.desc.nullslast,id.asc';
        const res = await fetchImpl(url, {
          headers: { apikey: config.supabaseAnonKey },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return errorResult(`model_catalog 查询失败: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        const rows = await res.json();
        const available = [];
        const asyncUnavailable = [];
        for (const row of Array.isArray(rows) ? rows : []) {
          if (isAsyncImageModel(row.id)) {
            asyncUnavailable.push(row.id);
            continue;
          }
          available.push({
            id: row.id,
            vendor: row.vendor,
            label: row.label,
            description: row.description || undefined,
            is_vip: row.is_vip || undefined,
          });
        }
        return {
          content: [
            textContent({
              success: true,
              default: config.defaultModel,
              count: available.length,
              models: available,
              async_unavailable: asyncUnavailable,
            }),
          ],
        };
      } catch (error) {
        return errorResult(`查询模型失败：${error?.message || error}`);
      }
    }
  );

  // ---------- check_quota ----------
  server.registerTool(
    'check_quota',
    {
      title: '查询生图配额',
      description: '查询当前账号本月生图配额（limit/used/remaining/period）。',
      inputSchema: {},
    },
    async () => {
      try {
        const quota = await client.getQuota();
        return { content: [textContent({ success: true, quota })] };
      } catch (error) {
        return errorResult(`查询配额失败：${error?.message || error}`);
      }
    }
  );

  return server;
}

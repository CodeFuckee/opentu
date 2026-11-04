/**
 * MiniMax H3（本地网关）视频适配器
 *
 * 上游：服务器本地部署的 h3-video 网关（~/h3-video/gateway/app.py，ComfyUI 后端，
 * Ref2VA INT8 + Turbo LoRA）。协议：
 *   POST /v1/videos          multipart 提交 → {id, status}
 *   GET  /v1/videos/{id}     轮询 → {id, status, video_url?, error?}
 *   完成后 video_url 指向网关 /v1/videos/{id}/content（mp4）
 * 网关参数约束（app.py 实读校准）：
 *   - seconds 钳制 1~10，默认 5
 *   - size 按「宽x高」正则解析（`720p@16:9` 这类组合串解析不到，须先换算成 WxH），
 *     保留宽高比，超像素预算（~0.52MP）自动等比缩小
 *   - 参考图字段 image[]（最多 9 张）；prompt 必填
 */
import type {
  AdapterContext,
  VideoGenerationRequest,
  VideoModelAdapter,
} from './types';
import { registerModelAdapter } from './registry';
import { sendAdapterRequest } from './context';

const MINIMAX_H3_MODELS = ['minimax-h3'];

/** 上游网关记录用的实际模型名（网关不校验，仅为任务留档准确） */
const MINIMAX_H3_ACTUAL_MODEL = 'MiniMax-H3';

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_MAX_ATTEMPTS = 720; // ~60 min（本地 Turbo 4-step 通常 1~3 分钟）
const MAX_REFERENCE_IMAGES = 9;

type H3SubmitResponse = {
  id: string;
  status: string;
  model?: string;
  detail?: unknown;
};

type H3QueryResponse = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  video_url?: string;
  url?: string;
  duration_s?: number;
  error?: { message?: string } | string;
  message?: string;
};

/**
 * 将逻辑尺寸（`720p@16:9` 组合串或 `1280x720`）换算为网关可解析的 `宽x高`。
 * 分辨率指短边（720p 横屏 = 1280x720 名义值）；对齐取 floor 到 32 的倍数，
 * 与网关 _map_size 的对齐规则一致（超像素预算时网关还会等比缩小）。
 */
export const parseSizeToPixels = (size?: string): string => {
  const trimmed = (size || '').trim();
  if (/^\d+\s*[xX*]\s*\d+$/.test(trimmed)) {
    return trimmed.replace(/\s+/g, '').replace(/[X*]/g, 'x');
  }
  const [rawResolution, rawRatio] = trimmed.split('@');
  const resolution = parseInt(rawResolution, 10) || 720;
  const [ratioW, ratioH] = (rawRatio || '16:9')
    .split(':')
    .map((v) => parseInt(v, 10) || 0);
  const ratio = ratioW > 0 && ratioH > 0 ? [ratioW, ratioH] : [16, 9];
  const align32 = (value: number) => Math.max(32, Math.floor(value / 32) * 32);
  const [w, h] =
    ratio[0] >= ratio[1]
      ? [resolution * (ratio[0] / ratio[1]), resolution]
      : [resolution, resolution * (ratio[1] / ratio[0])];
  return `${align32(w)}x${align32(h)}`;
};

/** 网关钳制 1~10（缺省 5），提交前先归一；params.seconds 兜底字符串时长 */
export const normalizeH3Seconds = (
  duration?: number,
  paramsSeconds?: unknown
): string => {
  const parsed =
    (duration ??
      (typeof paramsSeconds === 'string' ? parseInt(paramsSeconds, 10) : NaN)) ||
    5;
  return String(Math.min(10, Math.max(1, parsed)));
};

const resolveBaseUrl = (context: AdapterContext): string => {
  if (!context.baseUrl) {
    throw new Error('Missing baseUrl for MiniMax H3 adapter');
  }
  return context.baseUrl.replace(/\/$/, '');
};

const extractErrorMessage = (data: unknown, fallback: string): string => {
  const payload = (data || {}) as {
    error?: string | { message?: string };
    message?: string;
    detail?: unknown;
  };
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error?.message) return payload.error.message;
  if (payload.message) return payload.message;
  if (typeof payload.detail === 'string' && payload.detail) return payload.detail;
  return fallback;
};

/** 将 base64 data URL 或远程 URL 转为 Blob */
const urlToBlob = async (url: string): Promise<Blob> => {
  const response = await fetch(url);
  return response.blob();
};

/**
 * 提交 MiniMax H3 视频生成任务
 */
const submitH3Video = async (
  context: AdapterContext,
  params: {
    prompt: string;
    seconds: string;
    size: string;
    referenceImages?: string[];
  }
): Promise<H3SubmitResponse> => {
  const baseUrl = resolveBaseUrl(context);

  const formData = new FormData();
  formData.append('model', MINIMAX_H3_ACTUAL_MODEL);
  formData.append('prompt', params.prompt);
  formData.append('seconds', params.seconds);
  formData.append('size', params.size);

  for (const ref of (params.referenceImages || []).slice(
    0,
    MAX_REFERENCE_IMAGES
  )) {
    const blob = await urlToBlob(ref);
    formData.append('image[]', blob, 'reference.png');
  }

  const response = await sendAdapterRequest(
    context,
    {
      path: '/v1/videos',
      method: 'POST',
      body: formData,
    },
    baseUrl
  );

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(
      extractErrorMessage(data, `MiniMax H3 submit failed: ${response.status}`)
    );
  }

  return response.json();
};

/**
 * 查询 MiniMax H3 视频生成状态
 */
const queryH3Video = async (
  context: AdapterContext,
  taskId: string
): Promise<H3QueryResponse> => {
  const baseUrl = resolveBaseUrl(context);
  const response = await sendAdapterRequest(
    context,
    {
      path: `/v1/videos/${taskId}`,
      method: 'GET',
    },
    baseUrl
  );

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(
      extractErrorMessage(data, `MiniMax H3 query failed: ${response.status}`)
    );
  }

  return response.json();
};

export const minimaxH3VideoAdapter: VideoModelAdapter = {
  id: 'minimax-h3-video-adapter',
  label: 'MiniMax H3 Video',
  kind: 'video',
  matchProtocols: ['minimax.h3.task'],
  supportedModels: MINIMAX_H3_MODELS,
  defaultModel: 'minimax-h3',

  async generateVideo(context, request: VideoGenerationRequest) {
    const onProgress = request.params?.onProgress as
      | ((progress: number, status?: string) => void)
      | undefined;
    const onSubmitted = request.params?.onSubmitted as
      | ((videoId: string) => void)
      | undefined;

    onProgress?.(5, 'submitting');

    // 网关钳制 1~10（默认 5），提交前先归一
    const seconds = normalizeH3Seconds(
      request.duration,
      request.params?.seconds
    );

    const submitResult = await submitH3Video(context, {
      prompt: request.prompt,
      seconds,
      size: parseSizeToPixels(request.size),
      referenceImages: request.referenceImages,
    });

    const taskId = submitResult.id;
    if (!taskId) {
      throw new Error('MiniMax H3 网关未返回任务 ID');
    }

    onSubmitted?.(taskId);

    onProgress?.(10, 'queued');

    // 轮询
    let attempts = 0;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 10;

    while (attempts < DEFAULT_POLL_MAX_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS)
      );
      attempts += 1;

      let isBusinessFailure = false;

      try {
        const status = await queryH3Video(context, taskId);
        consecutiveErrors = 0;

        onProgress?.(
          status.status === 'completed' ? 100 : 10,
          status.status
        );

        if (status.status === 'completed') {
          const url = status.video_url || status.url;
          if (!url) {
            throw new Error('MiniMax H3 结果缺少视频 URL');
          }
          return {
            url,
            format: 'mp4',
            duration: status.duration_s
              ? Math.round(status.duration_s)
              : undefined,
            raw: status,
          };
        }

        if (status.status === 'failed') {
          isBusinessFailure = true;
          throw new Error(extractErrorMessage(status, '视频生成失败'));
        }
      } catch (err: unknown) {
        if (isBusinessFailure) {
          throw err;
        }

        consecutiveErrors++;
        console.warn(
          '[MiniMaxH3] Status query failed, attempt ' +
            `${consecutiveErrors}/${maxConsecutiveErrors}:`,
          err instanceof Error ? err.message : err
        );

        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw err;
        }

        const backoffInterval = Math.min(
          DEFAULT_POLL_INTERVAL_MS * Math.pow(1.5, consecutiveErrors),
          60000
        );
        await new Promise((resolve) =>
          setTimeout(resolve, backoffInterval - DEFAULT_POLL_INTERVAL_MS)
        );
      }
    }

    throw new Error('MiniMax H3 视频生成超时');
  },
};

export const registerMinimaxH3Adapter = (): void => {
  registerModelAdapter(minimaxH3VideoAdapter);
};

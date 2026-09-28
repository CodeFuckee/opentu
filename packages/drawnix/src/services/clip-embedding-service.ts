/**
 * CLIP 图像向量服务(#61 以图搜图,浏览器侧)。
 *
 * - 编码:transformers.js(WASM)懒加载 CLIP ViT-B/32 vision(int8,~89MB,
 *   从公开桶 ai-outputs/models/clip 分发,内网下载一次后浏览器缓存);
 *   与批量脚本(scripts/build-asset-vectors.mjs)共用同一模型与配置,
 *   保证两侧向量空间一致。
 * - 检索:经 supabase functions.invoke 调 edge function asset-vector-search
 *   (自动携带用户 JWT),服务端 pgvector 余弦 top-k。
 * - transformers.js 库本身也从桶远程加载(450KB ESM):vite 打包它会把
 *   onnxruntime 的巨型资产卷进 bundle(实测 chunk 139MB、CI build OOM),
 *   故以绝对 URL 动态 import + @vite-ignore,主包零新增体积。
 *   WASM 无 secure-context 依赖,内网 HTTP 可用。
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const EMBEDDING_DIM = 512;

export interface SimilarAssetResult {
  assetType: string;
  assetId: string;
  imageUrl: string;
  name: string | null;
  category: string | null;
  similarity: number;
}

/** 模型所在桶路径(浏览器端 env.remoteHost);未登录/未注册官方库配置时为 null */
function modelHost(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/ai-outputs/models/clip`;
}

type Extractor = (
  input: unknown,
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array | number[] }>;

/** transformers.js 桶内库产物的结构(运行时远程加载,不参与 vite 打包) */
interface TransformersLib {
  pipeline: (
    task: string,
    model: string,
    opts: Record<string, unknown>
  ) => Promise<unknown>;
  RawImage: { fromBlob: (blob: Blob) => Promise<unknown> };
  env: {
    allowLocalModels: boolean;
    remoteHost: string;
    remotePathTemplate: string;
    backends?: { onnx?: { wasm?: { wasmPaths?: string } } };
  };
}

/** 与编码器一同懒加载的 RawImage 构造器(loadExtractor 成功后非空) */
let rawImageCtor: TransformersLib['RawImage'] | null = null;
let extractorPromise: Promise<Extractor> | null = null;

/** 懒加载编码器(重复调用共享同一 promise);onProgress 用于首次下载进度提示 */
async function loadExtractor(
  supabaseUrl: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const libUrl = `${modelHost(supabaseUrl)}/lib/transformers.bundle.mjs`;
      const { pipeline, RawImage, env } = (await import(
        /* @vite-ignore */ libUrl
      )) as TransformersLib;
      // 模型从公开桶分发(HF 仓库布局平铺;v4 的 remotePathTemplate 不含 {file},
      // 请求文件名由库自动追加在模板之后,故模板只到 {model}/ 为止)
      env.allowLocalModels = false;
      env.remoteHost = modelHost(supabaseUrl);
      env.remotePathTemplate = '{model}/';
      // onnxruntime WASM 后端默认走 jsdelivr CDN(内网不可达),指到桶内 ort 目录
      const ortEnv = env.backends?.onnx?.wasm;
      if (ortEnv) {
        ortEnv.wasmPaths = `${modelHost(supabaseUrl)}/ort/`;
      }
      rawImageCtor = RawImage;
      const pipe = (await pipeline('image-feature-extraction', MODEL_ID, {
        dtype: 'q8',
        progress_callback: (info: unknown) => {
          const p = info as { status?: string; loaded?: number; total?: number };
          if (p?.status === 'progress' && p.total && onProgress) {
            onProgress(p.loaded ?? 0, p.total);
          }
        },
      })) as unknown as Extractor;
      return pipe;
    })().catch((error) => {
      extractorPromise = null; // 失败允许重试
      throw error;
    });
  }
  return extractorPromise;
}

/** 图片 → 512 维归一化向量(与批量脚本同配置:pooling mean + normalize) */
export async function embedImage(
  supabaseUrl: string,
  file: Blob,
  onProgress?: (loaded: number, total: number) => void
): Promise<number[]> {
  const extractor = await loadExtractor(supabaseUrl, onProgress);
  const image = await rawImageCtor!.fromBlob(file);
  const output = await extractor(image, { pooling: 'mean', normalize: true });
  const vec = Array.from(output.data);
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`CLIP 输出维度异常: ${vec.length}`);
  }
  return vec;
}

export interface SearchSimilarOptions {
  assetTypes?: string[];
  topK?: number;
}

/** 向量检索:经 edge function(asset-vector-search)查 pgvector top-k */
export async function searchSimilarAssets(
  client: Pick<SupabaseClient, 'functions'>,
  embedding: number[],
  options: SearchSimilarOptions = {}
): Promise<SimilarAssetResult[]> {
  const { data, error } = await client.functions.invoke('asset-vector-search', {
    body: {
      embedding,
      ...(options.assetTypes ? { assetTypes: options.assetTypes } : {}),
      ...(options.topK ? { topK: options.topK } : {}),
    },
  });
  if (error) {
    throw new Error(`以图搜图检索失败: ${error.message}`);
  }
  const results = (data as { results?: SimilarAssetResult[] })?.results;
  if (!Array.isArray(results)) {
    throw new Error('以图搜图检索返回异常');
  }
  return results;
}

/** 编码器是否已加载(避免重复进度提示) */
export function isClipExtractorLoaded(): boolean {
  return extractorPromise !== null;
}

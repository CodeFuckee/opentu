/**
 * Edge Function: image-segmentation (entry)
 *
 * 智能抠图推理入口(详见 core.ts)。Self-hosted 实例:SUPABASE_URL 为
 * 容器内网关地址;segment-server 与本容器同在 supabase_default 网络,
 * 默认经容器名直达,可用 SEGMENT_SERVICE_URL 覆盖。
 */
import { handleImageSegmentation } from './core.ts';

Deno.serve(async (request: Request) => {
  return handleImageSegmentation(request, {
    supabaseUrl: Deno.env.get('SUPABASE_URL') || '',
    anonKey: Deno.env.get('SUPABASE_ANON_KEY') || '',
    segmentServiceUrl: Deno.env.get('SEGMENT_SERVICE_URL') || undefined,
  });
});

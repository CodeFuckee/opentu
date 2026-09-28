/**
 * Edge Function: asset-vector-search (entry)
 *
 * 以图搜图检索入口(详见 core.ts)。Self-hosted 实例:
 * SUPABASE_URL 为容器内网关地址(http://api-gw:8000)。
 */
import { handleAssetVectorSearch } from './core.ts';

Deno.serve(async (request: Request) => {
  return handleAssetVectorSearch(request, {
    supabaseUrl: Deno.env.get('SUPABASE_URL') || '',
    anonKey: Deno.env.get('SUPABASE_ANON_KEY') || '',
  });
});

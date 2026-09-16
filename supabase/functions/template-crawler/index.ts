/**
 * Edge Function: template-crawler (entry)
 *
 * 从建筑学长同步 AI 模板到 ai_templates 表（列表+详情两阶段、增量、封面转存）。
 * 仅管理员（JWT + configs.TEMPLATE_CRAWLER_ADMINS）可触发。
 *
 * POST /functions/v1/template-crawler
 *   {"action": "crawl", "templateTypes": ["BANANA_CASE"], "maxPages": 3, "withCovers": true}
 *   {"action": "stats"}
 */
import { handleTemplateCrawler } from './core.ts';

Deno.serve(async (request: Request) => {
  return handleTemplateCrawler(request, {
    SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    SUPABASE_URL: Deno.env.get('SUPABASE_URL') || '',
    SUPABASE_PUBLIC_URL: Deno.env.get('SUPABASE_PUBLIC_URL') || '',
  });
});

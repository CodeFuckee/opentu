-- ============================================================
-- model_catalog：新增 MiniMax H3（本地网关，云端模型目录运营通道）
--
-- 用法（自托管 Supabase，手工执行）：
--   先把本文件拷到服务器 supabase 栈目录：
--   scp supabase/migrations/model_catalog_minimax_h3.sql mdc@10.0.0.220:~/codes/supabase/migrations/
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < ~/codes/supabase/migrations/model_catalog_minimax_h3.sql
--
-- ⚠️ 部署顺序：model_catalog 表非空时前端模型列表被云端目录完全接管。
--    本行插入后，所有前端（含尚未升级的旧版生产前端）的模型下拉都会出现
--    MiniMax H3；旧前端没有对应 adapter 与 ai-proxy 分流配置，选择即失败。
--    因此必须在「包含 minimax-h3 adapter 的前端 + ai-proxy 本地网关分流
--    （local_video_gateway.sql 的 configs 写入）」都生效之后再执行本文件。
--
-- 本地网关前提（mdc@10.0.0.220）：~/h3-video 网关 8788 端口存活（/health 自检）；
-- 网关返回的 video_url 以 PUBLIC_BASE 为 host，须为用户可达地址（10.0.0.220）。
--
-- 幂等：重复执行按 id upsert。回滚：delete from model_catalog where id='minimax-h3';
-- ============================================================

insert into public.model_catalog (
  id, type, vendor, label, short_label, short_code, description,
  is_vip, supports_tools, recommended_score,
  image_defaults, video_defaults, tags, enabled
) values (
  'minimax-h3',
  'video',
  'MINIMAX',
  'MiniMax H3（本地）',
  '',
  'mmh3',
  '本地部署 MiniMax H3，支持多参考图与音频',
  false,
  false,
  70,
  null,
  '{"size": "720p", "duration": "5", "aspectRatio": "16:9"}'::jsonb,
  '{}'::text[],
  true
)
on conflict (id) do update set
  label         = excluded.label,
  short_code    = excluded.short_code,
  description   = excluded.description,
  is_vip        = excluded.is_vip,
  recommended_score = excluded.recommended_score,
  video_defaults    = excluded.video_defaults,
  enabled           = excluded.enabled,
  updated_at        = now();

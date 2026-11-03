-- ============================================================
-- model_catalog：新增 Seedance 2.5 Pro（云端模型目录运营通道）
--
-- 用法（自托管 Supabase，手工执行）：
--   先把本文件拷到服务器 supabase 栈目录：
--   scp supabase/migrations/model_catalog_seedance25.sql mdc@10.0.0.220:~/codes/supabase/migrations/
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < ~/codes/supabase/migrations/model_catalog_seedance25.sql
--
-- ⚠️ 部署顺序：model_catalog 表非空时前端模型列表被云端目录完全接管。
--    本行插入后，所有前端（含尚未升级的旧版生产前端）的模型下拉都会出现
--    Seedance 2.5 Pro；旧前端没有对应 adapter 映射（会拼出不存在的
--    doubao-seedance-2-5-pro_720p），选择即失败。因此必须在
--    「包含 seedance-2.5-pro adapter 改造的前端」部署到生产之后再执行本文件。
--
-- 幂等：重复执行按 id upsert。回滚：delete from model_catalog where id='seedance-2.5-pro';
-- ============================================================

insert into public.model_catalog (
  id, type, vendor, label, short_label, short_code, description,
  is_vip, supports_tools, recommended_score,
  image_defaults, video_defaults, tags, enabled
) values (
  'seedance-2.5-pro',
  'video',
  'DOUBAO',
  'Seedance 2.5 Pro',
  '',
  'sc25p',
  '即梦 2.5 有声视频，支持首尾帧',
  true,
  false,
  99,
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

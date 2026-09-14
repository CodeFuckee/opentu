-- ============================================================
-- model_catalog 增量条目：GPT Image 2.5 家族（tu-zi 网关）
--
-- 模型 ID 与价目接口（https://api.tu-zi.com/api/pricing）核对一致；
-- 目录级元数据在此维护，扩展比例参数白名单由前端代码挂接（随发版生效）。
--
-- 幂等：可重复执行；只影响本文件列出的 5 个 ID，
-- 不影响 model_catalog_seed.sql 的 78 条种子，也不会删除其他手工条目。
--
-- 执行方式（二选一）：
--   1) Supabase 宿主机：docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/seed/model_catalog_gpt_image_25.sql
--   2) Supabase Studio SQL 编辑器粘贴执行
-- ============================================================

insert into public.model_catalog (
  id, type, vendor, label, short_label, short_code, description,
  is_vip, supports_tools, recommended_score, image_defaults, video_defaults, tags
) values
  (
    'gpt-image-2.5-vip', 'image', 'GPT',
    'gpt-image-2.5-vip', null, 'gpt25v',
    'GPT Image 2.5 优选路由 · 平台当前优选图像渠道',
    true, true, 97,
    jsonb '{"aspectRatio":"auto","width":1024,"height":1024}',
    null,
    '{}'::text[]
  ),
  (
    'gpt-image-2.5', 'image', 'GPT',
    'gpt-image-2.5', null, 'gpt25',
    'GPT Image 2.5 通用路由 · 平台按可用渠道自动调度',
    false, true, 96,
    jsonb '{"aspectRatio":"auto","width":1024,"height":1024}',
    null,
    '{}'::text[]
  ),
  (
    'gpt-image-2.5-flare', 'image', 'GPT',
    'gpt-image-2.5-flare', null, 'g25fl',
    'GPT Image 2.5 Flare · 官方模型，快速高质量日常生图',
    false, true, 93,
    jsonb '{"aspectRatio":"auto","width":1024,"height":1024}',
    null,
    '{}'::text[]
  ),
  (
    'gpt-image-2.5-sunburst', 'image', 'GPT',
    'gpt-image-2.5-sunburst', null, 'g25sb',
    'GPT Image 2.5 Sunburst · 官方模型，编辑精度优先（局部修改/文字排版）',
    false, true, 92,
    jsonb '{"aspectRatio":"auto","width":1024,"height":1024}',
    null,
    '{}'::text[]
  ),
  (
    'gpt-image-2.5-1k', 'image', 'GPT',
    'gpt-image-2.5-1k', null, 'g25k',
    'GPT Image 2.5 1K · 低成本按次计费，固定尺寸集合（1:1 / 2:3 / 3:2）',
    false, true, 88,
    jsonb '{"aspectRatio":"auto","width":1024,"height":1024}',
    null,
    '{}'::text[]
  )
on conflict (id) do update set
  type = excluded.type,
  vendor = excluded.vendor,
  label = excluded.label,
  short_label = excluded.short_label,
  short_code = excluded.short_code,
  description = excluded.description,
  is_vip = excluded.is_vip,
  supports_tools = excluded.supports_tools,
  recommended_score = excluded.recommended_score,
  image_defaults = excluded.image_defaults,
  tags = excluded.tags,
  enabled = true,
  updated_at = now();

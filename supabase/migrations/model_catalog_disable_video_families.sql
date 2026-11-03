-- ============================================================
-- model_catalog：下架 gemini/veo/kling/happyhorse 模型（含 kling 生图）
--
-- 用法（自托管 Supabase，手工执行）：
--   scp supabase/migrations/model_catalog_disable_video_families.sql mdc@10.0.0.220:~/codes/supabase/migrations/
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < ~/codes/supabase/migrations/model_catalog_disable_video_families.sql
--
-- 说明：
--   * model_catalog 非空即完全接管前端模型列表，enabled=false 是现成运营开关；
--     应用后所有前端（10 分钟 TTL / 启动强刷）的模型下拉立即不再出现这些模型。
--   * 幂等：重复执行无副作用。回滚（恢复上架）：
--     update model_catalog set enabled=true, updated_at=now()
--       where id in (/* 本次下架的 22 个 id，见下方注释 */);
--   * 范围（用户 2026-11-03 拍板）：四家视频模型全部下架；kling 生图连带下架；
--     seedance 全系与 sora 不动；adapter 代码保留（历史任务重试仍可用）。
--   * 涉及行（22）：kling_image；kling_video/kling-video-o1/kling-video-o1-edit；
--     happyhorse-1.0-{i2v,r2v,t2v,video-edit}；omni-flash{,-components}；
--     veo3{,-fast,-fast-frames,-frames,-pro,-pro-frames}；
--     veo3.1{,-4k,-components,-components-4k,-pro,-pro-4k}
-- ============================================================

update public.model_catalog
   set enabled = false,
       updated_at = now()
 where enabled = true
   and (id ilike 'kling%'
        or id ilike 'veo%'
        or id ilike 'omni-flash%'
        or id ilike 'happyhorse%')
   and (type = 'video' or type = 'image');

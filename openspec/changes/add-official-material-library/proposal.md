# Change: 素材库新增官方素材库（建筑学长爬取素材，jzxz 三级分类展示）

## Why

建筑学长贴图素材爬虫（`scripts/jzxz-material-crawler.py`，每日 03:00 定时增量）已将素材
转存到自托管 Supabase：公开读桶 `jzxz-materials`（内容寻址路径）+ 元数据表
`jzxz_materials`（gallery/category/tag 三级分类，RLS 登录可读）。当前库存 2175 条且持续
增长（植物配景 1834 / 自然环境 309 / 家居库 32，其余 8 分类由爬虫陆续补齐），但前端素材库
没有任何入口使用这批素材。

需要在素材库面板中新增「官方素材库」，并按建筑学长面板的方式分类展示：
库 tab（家居库/植物库/配景库）→ 分类 chips（仅配景库有）→ tag chips → 素材网格。

## What Changes

设计决策（2026-09-21 grill-me 访谈逐点确认，均采纳推荐项）：

1. **顶部双模式切换**：素材库面板主区顶部加「我的素材 / 官方素材库」切换。官方模式下，
   原类型 tab（全部/图片/视频/音频）与来源/类别 chips 隐藏，替换为建筑学长式三级筛选；
   个人素材的计数、过滤、上传、批量选择等不受影响。
2. **服务端分页 + 懒加载**：`jzxz_materials` 直查（supabase-js，走 RLS authenticated）。
   - facets（库/分类/tag 组合）：`select=gallery,category,tag` 分页扫描 + 客户端去重，
     模块级缓存 5 分钟；空分类/空 tag 不渲染（爬虫补齐后自动出现）。
   - 素材网格：按当前筛选服务端分页（每页 60，`count=exact` 取总数），滚动近底部自动
     加载下一页；排序 `created_at desc, id asc`（稳定 tiebreaker，翻页不重不漏）。
3. **双模式开放，URL 直插**：BROWSE 与 SELECT 模式都可见官方库。图片用公开桶直链
   `/storage/v1/object/public/jzxz-materials/{path}` 直接插入画布/返回给宿主，不复制进
   个人素材库（官方库只读，个人库配额不膨胀）。HTTP 明文部署下直链为 LAN 地址，可用性
   已实测（匿名 GET 200）。
4. **隐藏空分类 + 带搜索**：计数为 0 的分类/tag 不渲染；官方模式提供搜索框，按素材名/tag
   服务端 `ilike` 过滤。

实现要点：

- 新增 `packages/drawnix/src/components/official-library/`：
  - `runtime.ts` — 宿主登录时注入 SupabaseClient（照抄 template-gallery 注册表模式，
    `configureOfficialLibrary({ client })` / `getOfficialLibraryConfig()`）
  - `official-library-service.ts` — facets 分页扫描去重、materials 分页查询（count=exact）、
    公开直链拼接、`OfficialMaterialRow → Asset` 视图映射（id 前缀 `official-`，type IMAGE，
    source OFFICIAL，不进 AssetContext/IndexedDB）
  - `OfficialLibraryView.tsx` + `official-library.scss` — 三级筛选 + 搜索 + 虚拟滚动网格
    （复用 `VirtualAssetGrid`/`AssetItem`/`UnifiedMediaViewer`，滚动近底触发加载更多）
  - `official-library-service.test.ts` — 链式 mock 客户端锁定查询形态（分页窗口、过滤、
    排序 tiebreaker、facets 去重、URL 拼接、Asset 映射）
- `AssetSource` 新增 `OFFICIAL`（全部用点为相等判断，无穷举 switch，兼容存量数据）；
  Inspector「来源」对 OFFICIAL 显示「官方」。
- `VirtualAssetGrid` 新增可选 `onLoadMore`（滚动近底部回调），不影响现有调用方。
- `MediaLibraryModal` 增加模式切换状态与切换 UI；官方模式选中素材走独立 state 喂给
  Inspector；官方素材为只读：Inspector 隐藏重命名/删除/设为主体（对应回调传空时按钮
  门控隐藏），保留下载与 SELECT「使用」。
- 宿主接线：`apps/web/src/supabase/auth-context.tsx` 登录态变化时
  `configureOfficialLibrary({ client })/configureOfficialLibrary(null)`（与模板中心同点注册）；
  `packages/drawnix/src/runtime.ts` 导出 `configureOfficialLibrary`。
- 未注册（未登录/宿主未接入）时官方模式显示空态提示，不报错。

## Impact

- Affected specs:
  - 新增 `official-material-library` capability（无现有 spec 覆盖素材库面板本身）
- Affected code:
  - `packages/drawnix/src/components/official-library/`（新增 5 文件）
  - `packages/drawnix/src/types/asset.types.ts`（AssetSource 加 OFFICIAL）
  - `packages/drawnix/src/components/media-library/VirtualAssetGrid.tsx`（可选 onLoadMore）
  - `packages/drawnix/src/components/media-library/MediaLibraryModal.tsx`（双模式集成）
  - `packages/drawnix/src/components/media-library/MediaLibraryInspector.tsx`（只读门控+来源文案）
  - `packages/drawnix/src/runtime.ts`（导出）
  - `apps/web/src/supabase/auth-context.tsx`（注册）
  - `CHANGELOG.md`（Added）
- 不改数据库/爬虫；`jzxz_materials` 与公开桶保持现状（RLS 登录可读 + 桶公开读已满足）。
- 不引入新依赖（supabase-js 已在 drawnix 依赖中）。

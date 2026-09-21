# Tasks: add-official-material-library

## 1. 服务层

- [ ] 1.1 `official-library/runtime.ts`：`OfficialLibraryConfig` 注册表（configure/get，null 注销）
- [ ] 1.2 `official-library-service.ts`：
  - [ ] `listOfficialFacets()` — 分页扫描 `select=gallery,category,tag` + 客户端去重，
        5 分钟模块缓存；输出库→分类→tag 树（只含有数据的节点）
  - [ ] `listOfficialMaterials({gallery,category,tag,search,limit,offset})` — 过滤 + 
        `created_at desc, id asc` + `.range()` + `count: 'exact'`
  - [ ] `officialPublicUrl(path)` — `client.supabaseUrl` + `/storage/v1/object/public/jzxz-materials/`
  - [ ] `officialMaterialToAsset(row)` — id `official-{source_id}`、type IMAGE、source OFFICIAL
- [ ] 1.3 `official-library-service.test.ts` — 链式 mock：查询形态、分页窗口、排序
        tiebreaker、facets 去重/缓存、URL 拼接、Asset 映射、未注册时抛错

## 2. 类型与基础组件

- [ ] 2.1 `AssetSource` 增加 `OFFICIAL`
- [ ] 2.2 `VirtualAssetGrid` 增加可选 `onLoadMore`（滚动近底部触发，节流防重复）

## 3. 官方库 UI

- [ ] 3.1 `OfficialLibraryView.tsx`：搜索框（防抖服务端 ilike）；库 tab（定制顺序
        家居库/植物库/配景库，未知库名追加）；分类 chips（该库存在分类才显示，可取消选中）；
        tag chips（选中分类后显示，可取消选中）；筛选变化重置分页重新加载
- [ ] 3.2 网格：`VirtualAssetGrid` + `AssetItem` 映射资产；加载更多拼接到尾部；
        空态/加载态/未注册提示
- [ ] 3.3 预览：`UnifiedMediaViewer`（双击预览，BROWSE 下可在预览器插入画布——
        `insertImageFromUrl(board, url)`）；页脚：共 N 个素材 + 加载中提示
- [ ] 3.4 `official-library.scss`：复用 media-library-grid 样式变量，新增三级筛选样式

## 4. 集成

- [ ] 4.1 `MediaLibraryModal`：`mine | official` 切换 UI 与状态；官方模式下主区渲染
        `OfficialLibraryView`、选中素材喂 Inspector（独立 state）；SELECT 使用回调复用
        `handleUseAsset`（URL 直插/返回宿主）
- [ ] 4.2 `MediaLibraryInspector`：`onRename/onDelete/onMarkAsSubject` 未传时对应按钮隐藏；
        来源文案 OFFICIAL →「官方」
- [ ] 4.3 `packages/drawnix/src/runtime.ts` 导出 `configureOfficialLibrary`
- [ ] 4.4 `apps/web/src/supabase/auth-context.tsx` 登录/登出注册/注销

## 5. 质量门禁

- [ ] 5.1 `pnpm vitest run`（drawnix 包）通过
- [ ] 5.2 `pnpm typecheck && pnpm lint` 通过
- [ ] 5.3 本地启动（非 localhost LAN 地址实测一次）：官方库加载、三级筛选、搜索、
        分页加载更多、双击预览、SELECT 使用、BROWSE 插入画布
- [ ] 5.4 `openspec validate add-official-material-library --strict` 通过
- [ ] 5.5 CHANGELOG.md 更新

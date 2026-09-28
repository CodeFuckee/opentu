# 技术方案:#61 以图搜图(上传/框选找同款)

> 2026-09-28 · grill-me 拷问后定稿 · 对应 docs/new-feature-plan-100.md #61(P0/L)
> 本方案同时是 #62(文搜图)/#66(相似推荐)/#82(素材 RAG)的向量基建底座。
> 状态:**待拍板实施**

## 一、已拍板决策(2026-09-28)

| 决策点 | 结论 |
|---|---|
| 一期范围 | **四库一次覆盖**:配景库(jzxz_materials)+家居+植物+模板中心封面(全部「DB 行+公开桶直链」);「我的素材」(IndexedDB)与画布元素右键/框选找同款 → 二期 |
| 查询侧向量化 | **浏览器 WASM**(transformers.js 跑 CLIP vision,int8 模型 ~25MB 放公开桶,内网下载一次后缓存);WASM 无 secure-context 依赖,内网 HTTP ✓ |
| 存量批量+增量 | **本机 node 离线脚本**(与浏览器同一份模型代码,保证向量空间一致)+ 每日定时 `--since` 增量;爬虫不改,服务器不跑模型 |
| 入口与展示 | **搜索区「以图搜图」入口**(上传/拖拽/粘贴)→ 结果按相似度降序进**现有网格**(卡片带相似度% 角标),复用现有卡片/详情/插入链路;素材库官方库与模板中心两入口 |

## 二、现状事实(摸底结论)

- **pgvector 0.8.2 可用未启用**(生产库 `pg_available_extensions` 有包,一条 `create extension` 开启;0.8.x 支持 HNSW 索引)。
- 数据面(生产库 2026-09-28 实测):配景库 **21,404 行**(桶图 17,777)、家居 906(多视图合计 4,393 图)、植物 463、模板 **1,310**(封面桶 1,313)——需向量化图片 **~23,600 张**,全部公开桶直链可批量拉。
- 无现成 embedding 基建;tu-zi 网关无图像 embedding 模型;edge function 有 60s 墙钟+CPU 限制,不能跑推理。
- 内网 HTTP 对 WASM/WebGL 无限制;公开桶直链浏览器可直取。

## 三、架构

```
┌─ 存量/增量(本机 node,一次 + 每日)────────────────┐
│ scripts/build-asset-vectors.mjs                     │
│  拉公开桶图 → transformers.js CLIP vision(512d)     │
│  → upsert asset_vectors(断点续跑/--since 增量)      │
└──────────────────────────────────────────────────────┘
                      ↓ pgvector(HNSW)
┌─ 查询(浏览器 → edge function → pgvector)───────────┐
│ 上传/拖拽/粘贴图 → transformers.js(WASM,同一模型)   │
│  → 512d 向量 → POST /functions/v1/asset-vector-search│
│  → RPC search_similar_assets(向量→top-k,join 原表   │
│    元数据 name/category)→ 现有网格按相似度渲染       │
└──────────────────────────────────────────────────────┘
```

### 3.1 模型与向量约定

- **CLIP ViT-B/32 int8**(Xenova/clip-vit-base-patch32 的 ONNX 量化版,vision encoder
  ~25MB):图搜图是 image→image,语言无关,无需 Chinese-CLIP;未来 #62 文搜图时再评估
  换中文 CLIP 或翻译层(**换模型=向量空间更换,须全量重刷**,故 `model_version` 列必备)。
- 统一 512 维,余弦相似;**批量与查询共用同一份模型与预处理代码**(node/浏览器同
  transformers.js),从根上杜绝两侧向量空间不一致。

### 3.2 数据库(迁移 clip_vectors.sql)

```sql
create extension if not exists vector;
create table public.asset_vectors (
  id uuid primary key default gen_random_uuid(),
  asset_type text not null,      -- jzxz_materials/jzxz_home_materials/jzxz_plant_materials/ai_templates
  asset_id  text not null,       -- 原表主键(source_id / template id)
  image_url text not null,       -- 该向量对应的图片直链(家居/植物多视图一行一图)
  embedding vector(512) not null,
  model_version text not null,   -- 'clip-vit-b32-int8-v1'
  updated_at timestamptz not null default now(),
  unique (asset_type, asset_id, image_url)
);
create index on public.asset_vectors using hnsw (embedding vector_cosine_ops);
-- RLS:authenticated 可读;写仅 service_role(批量脚本/未来增量任务)
-- RPC:search_similar_assets(query_embedding, asset_type[], match_count)
--   → 1 - (embedding <=> query) 降序,join 原表回 name/category,返回 similarity
```

- 家居/植物多视图:`image_paths` 每图一条向量(asset_id 同 source_id,结果按
  (asset_id) 去重取最高分)。
- 幂等:唯一键 on conflict update;重跑安全。

### 3.3 批量与增量脚本(scripts/build-asset-vectors.mjs)

- node ≥18 + `@huggingface/transformers`(新增 devDependency,浏览器侧用
  动态 import 同包产物);并发 4、逐张失败不中断、失败清单落盘可重跑。
- 模型文件:首次从 HF 下载后落本地缓存;**另拷贝到公开桶 `models/` 目录**
  供浏览器端下载(内网机器访问 HF 不稳定,浏览器只走桶)。
- 增量:`--since 2026-09-28` 只处理 updated_at 晚于阈值的行;挂到现有每日定时任务
  (与模板同步同窗口),爬虫零改动。
- 预估:23.6k 张 × ~80ms ≈ 30-40 分钟(一次性,本机 CPU)。

### 3.4 检索服务(supabase/functions/asset-vector-search)

- POST,JWT 鉴权(登录用户即可,非管理员功能);body `{ embedding: number[512],
  assetTypes?: string[], topK?: number }`,服务端钳制 topK≤50。
- 调 RPC → 返回 `[{ assetType, assetId, imageUrl, name, category, similarity }]`
  (元数据在 SQL join,前端零回查)。
- 校验:向量长度/数值域;异常 4xx;node:test 单测覆盖鉴权/校验/RPC 映射。

### 3.5 前端(packages/drawnix)

- `services/clip-embedding-service.ts`(懒加载 transformers.js+模型,缓存编码器;
  `embedImage(blob): Promise<number[512]>`)——node 脚本复用同一模型配置常量。
- 入口:素材库官方 tab 搜索区与模板中心搜索区各加「以图搜图」图标按钮:
  点击弹文件选择/支持拖拽与粘贴剪贴板;选中后进入**相似模式**:输入框替换为
  缩略图 chip(可清除),网格按相似度渲染现有卡片 + 角标 `92%`。
- 结果卡片复用现有选中/详情/插入链路(相似模式详情走 imageUrl 直插)。
- 加载态:模型首次下载/编码中在入口处显示进度;失败给出可读提示并回退普通搜索。

## 四、测试与验收

- 单测:RPC 相似度排序/去重(join 元数据正确);edge function 鉴权/参数校验;
  前端 embed 服务 mock(transformers.js 不进 vitest)。
- 批量脚本 dry-run 模式(只统计不写库)+ 幂等重跑验证。
- E2E(1 条 smoke,挂素材库 spec):上传 fixture 图 → 断言相似结果网格出现且
  带角标、点击可插入画布;CI 需库里有向量(批量为 CI 库预置少量种子向量,或 CI
  跳过该用例并在内网实测——实施时定)。
- 手动过目(必须):内网 LAN 地址上传/拖/粘贴三通道、家居多视图去重、相似度
  排序合理性(同款>同风格>无关)、清 chip 恢复普通搜索、未登录提示。
- 验收标准:上传一张配景素材图,同款图相似度 ≥0.9 排第一;查询往返(编码+检索)
  内网 <2s(首次模型下载另计);四库各抽测一图可搜出同库相似结果。

## 五、工作量与风险

分解(总 L,~6 个工作日):迁移+RPC+RLS 0.5d → 批量脚本+桶模型部署 1.5d →
edge function+单测 1d → 前端 embed 服务+两入口+相似模式 2d → E2E+内网过目 1d。

风险与对策:
1. **向量空间一致性**:node 与浏览器共用 transformers.js 同模型配置;上线前用同一
   图双侧编码比对余弦>0.999 做冒烟。
2. **transformers.js 浏览器体积/性能**:仅 vision encoder(int8 ~25MB),懒加载独立
   chunk;单图编码 WASM ~0.3-1s 可接受,不达标再评估 WebGPU 加速(WASM 兜底仍在)。
3. **批量中断**:断点续跑+失败清单;`--since` 每日兜底自愈。
4. **模型升级不兼容**:model_version 列,新版本=新值+全量重刷脚本已备。
5. **HF 不可达**:模型文件统一从公开桶分发(脚本与浏览器都先查桶)。

## 六、明确不做(一期)

- 「我的素材」(IndexedDB)本地向量索引;画布元素右键「找同款」/框选搜图(二期,
  复用本基建,只加取图入口);文搜图(#62,需中文 CLIP 评估);向量自动清理
  (素材删除同步删向量——四库均为爬虫只读数据,删除场景暂不存在)。

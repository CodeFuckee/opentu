# Change: 智能抠图（服务端 SAM3 点提示分割）

## Why

建筑画布拼贴场景里，用户经常需要把家具、人物、植物等目标从图片背景中抠出变成透明底素材。目前只能靠生成式 AI 编辑或外部工具，没有"点一下就选中目标"的交互式抠图能力。功能计划表 #41（选中元素 AI 操作菜单，P0）中的核心子能力"抠图"需要一套分割推理服务先行落地。

## What Changes

- 新增服务端推理容器 `sam3-server`（FastAPI + torch + SAM3，GPU bf16 优先、CPU 回退），加入 supabase 容器网络，不对外发布端口
- 新增 edge function `image-segmentation`：复用 asset-vector-search 的 JWT 鉴权模式，向内网容器转发 encode/segment 请求（零 CSP 改动）
- 图片编辑器（ImageEditorCore）新增第三种编辑模式 `cutout`（抠图）：点击正/负点 → 服务端返回 mask → 全分辨率合成透明 PNG → 复用现有 onInsert/onSave(dataURL) 链路插入画布
- 前端新增 `segmentation-service.ts`（functions.invoke 封装）与 `cutout-compose.ts`（mask 合成纯函数，含羽化），配套单测
- 服务端会话缓存（LRU + TTL）实现"一次编码、多次点击"的交互式体验

## Impact

- Affected specs: 新增 capability `smart-cutout`（本 change 的 specs/smart-cutout/spec.md）
- Affected code:
  - 新增 `services/sam3-server/`（Python 服务 + Dockerfile + pytest）、`supabase/functions/image-segmentation/`
  - 修改 `packages/drawnix/src/components/image-editor/`（types.ts 的 EditMode、ImageEditorCore 模式切换、新增 CutoutPanel）
  - 新增 `packages/drawnix/src/services/segmentation-service.ts`、`cutout-compose.ts`（services/ 或 components/image-editor/ 下）
  - 文档：apps/web/public/user-manual、docs/new-feature-plan-100.md（#41 关联标注）、CHANGELOG.md
- 服务器：新增一个 docker 容器（约 6–8GB 镜像 + 约 3–7GB 模型文件，磁盘余量 431GB 充足）
- 不改数据库 schema、不改 CSP、不新增前端 npm 依赖

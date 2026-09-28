# OpenTU 新功能计划表(100 条,借鉴同类产品,2026-09-28)

> 方法:先盘点同类产品(开源+商业),按本项目六大资产(画布/生成任务队列/素材库/
> 模板中心/知识库/看板)与两条硬约束(**内网 HTTP 部署**、建筑行业用户群)逐条映射。
> 优先级:P0=下一迭代即做(高价值/低悬果实),P1=规划内,P2=远期观察。
> 工作量:S≤1 周,M≈2-4 周,L>1 月(粗估,含测试)。
> 状态:✅=已完成上线(附 commit);🚧=部分完成/基础就绪;空=未动工。
> ⚠️ 标注【HTTP】的条目依赖 secure-context API(getUserMedia/getDisplayMedia/SW 等),
> 内网 HTTP 下不可用或需服务端降级,动工前先按仓库 AGENTS.md 约束验证。

## 〇、更新记录

- **2026-09-28:#32 完成** ✅(fdcaac1f→92cc68ca 四轮迭代,#3050~#3071 流水线全绿):
  @google/model-viewer 懒加载全屏预览(旋转/缩放/进度/超时降级,家居+植物库同构生效);
  超计划交付「**插入视角到画板**」——当前视角截图先传 ai-outputs 公开桶拿直链再插入
  (方案1 同模式)。画布内嵌 3D 视口按拍板转二期(需元素-资产关联改造)。
  过程沉淀三坑:React18 自定义元素 ref/className 不可靠、useEffect 绑定竞态(缓存命中
  秒加载)、虚拟 URL 无 SW 404(编辑器已接缓存降级)。

## 一、同类产品全景图

| 组别 | 产品 | 定位与可借鉴点 |
|---|---|---|
| 白板/画布(开源) | tldraw | Make Real 草图→可运行代码;画布 Agent |
| | Excalidraw | 手绘风白板;提示词→图示;Excalidraw-MCP 供 Agent 调用 |
| | Drawnix | 本项目上游(Plait 系),跟踪其新元素/插件 |
| | AFFiNE | 文档+白板+数据库一体,本地优先可自托管;AI 摘要/任务抽取 |
| | AppFlowy / Logseq / Obsidian | 本地优先知识库;块引用;全量导出 |
| 白板/画布(商业) | Miro(Miro AI) | 便签聚类、智能布局、演示模式、工坊模板 |
| | FigJam | AI 便签聚类/总结、投票计时器、评论@ |
| | Heptabase / Napkin | 卡片+画布知识管理;文本→图示 |
| | Canva Magic Studio | Magic Design/Media/Layers(位图转可编辑图层)、品牌套件 |
| | Adobe Firefly Boards | 生成画板、Generative Fill/Expand 无缝进版面 |
| | Figma AI / Figma Make | 文生 UI 组件、自动填充设计 |
| AI 生图画布 | Krea | 实时流式生成(边画边出)、多模型切换、实时风格化 |
| | Recraft | 矢量原生生成、自定义风格库、infinite canvas |
| | Ideogram Canvas | 文字排版强、Magic Fill/Extend |
| | Midjourney Web | 角色一致性 cref/sref、风格参考 |
| | Leonardo.Ai / Playground | 元素库(Element)+实时画布、模型微调 |
| | LiblibAI(哩布) / 星流 | 国内模型生态、社区模板市场、LoRA |
| | 即梦 / 通义万相 / 可灵 web | 国产多模态工作台、智能画布 |
| 生成工作站(开源) | ComfyUI | 节点式流水线、PNG 参数快照、自定义节点生态 |
| | InvokeAI / Fooocus / SD WebUI | 画布 inpaint/outpaint、Upscale、轻量模式 |
| 建筑/空间特化 | PromeAI | 草图→实景渲染、风格化、建筑AI全家桶(用户群高度重合) |
| | LookX AI | 建筑专属模型、SU/Revit 插件联动 |
| | Veras | BIM 内 AI 渲染、材质替换 |
| | Autodesk Forma | 早期体量+环境/日照/噪声快速分析 |
| | TestFit | 占地/容积率驱动的楼型自动拟合 |
| | Maket / ARCHITEChTURES | 住宅平面 AI 生成(约束式) |
| | D5 Render / Enscape | 实时渲染器内 AI 材质/氛围/后期 |
| 3D 生成 | Meshy / Tripo / Rodin | 文/图生 3D、PBR 材质、glb 直出(有 API) |
| | TRELLIS / Hunyuan3D / TripoSR(开源) | 自建 3D 生成服务(内网可行) |
| | Spline | 网页 3D 编辑器、交互场景嵌入 |
| 视频/数字人 | Runway(Gen-4) | 视频局部重绘、运镜控制、关键帧 |
| | Pika / Vidu / PixVerse | 首尾帧、特效模板、社区玩法 |
| | HeyGen / 腾讯智影 | 数字人播报、翻译配音 |
| | 剪映/CapCut | 字幕、转场模板、图文成片 |
| 音频/语音 | Suno / Udio(已接 Suno) | 分轨 stems、续写 |
| | ElevenLabs | TTS v3、音效 SFX、配音克隆 |
| | CosyVoice / GPT-SoVITS / Fish(开源) | 自建中文 TTS(内网友好) |
| | faster-whisper / FunAsr(开源) | 录音转写、字幕、实时听写 |
| | NotebookLM | 音频概览(双人播客)、素材问答 |
| 素材/资产管理 | Eagle / Billfish | 以图搜图、智能文件夹、色板检索、去重 |
| | Immich / PhotoPrism(开源) | 自托管照片库:AI 打标、人脸/语义搜索 |
| | Google Photos | 自动合集、回忆、相似去重 |
| 工作流/自动化 | ComfyUI(前端) / Dify / Flowise | 可视化流水线、模板→工作流 |
| | n8n(开源) / Zapier / Make | Webhook、定时、失败重试策略、审计 |
| 协作/同步基建 | Yjs + y-websocket(开源) | 实时协同(可自托管,内网可行) |
| | Liveblocks / PartyKit | 在线状态、评论、通知的托管件 |
| 汇报/演示 | Gamma / Tome | 大纲→PPT 全自动、网页演示、数据嵌入 |
| | Pitch | 模板品牌一致性、协作演讲 |
| AI 助手/RAG | Open WebUI / AnythingLLM / FastGPT / RAGFlow(开源) | 自托管知识问答、多模型路由 |
| | NotebookLM | 多源引用溯源回答 |

## 二、100 条新功能计划表

### A. AI 图像生成与编辑(依托:media 适配器/任务队列/画布图片元素)

| # | 新功能 | 借鉴来源 | 说明与落地 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| 1 | 局部重绘画笔(inpaint 画布化) | Firefly Generative Fill / InvokeAI | 已有 mask 编辑底子,升级为画笔涂抹+提示词+多次迭代,结果作为画布新元素 | P0 | M |
| 2 | 多模型并行对比(竞技场) | LM Arena / Poe | 同一 prompt 2/4 模型四宫格出图,点选采纳;任务队列已支持并发 | P0 | M |
| 3 | 无损放大/高清化(upscale 任务) | Magnific / LiblibAI | 任务队列新增 upscale 类型,素材库右键"放大 2x/4x" | P0 | M |
| 4 | 无限扩图(outpainting) | Firefly / Ideogram Extend | 选区外扩生成补全画面;与 1 共用遮罩管线 | P1 | M |
| 5 | 实时生图画布(边画边出) | Krea Realtime | 手绘/涂抹区域流式低延迟出图,需 Turbo/LCM 系模型与常驻连接 | P1 | L |
| 6 | 线稿/深度控制出图(建筑草图→渲染) | PromeAI / LookX / ControlNet | 上传 SU/手绘线稿,结构可控生成效果图;建筑用户刚需 | P1 | L |
| 7 | 风格预设库与一键风格化 | Recraft Styles / PromeAI | 模板中心新增"风格"维度,选中图片一键套用已存风格 | P1 | S |
| 8 | 背景移除/替换与无痕抹除 | Photoroom / Canva Magic Eraser | 素材库与画布右键入口;开源可选 rembg/BiRefNet 自建 | P1 | M |
| 9 | 角色一致性生成(参考锁定) | Midjourney cref / MJ sref | 同一角色/风格跨图一致;适配器参数白名单需扩展 | P2 | M |
| 10 | 位图转可编辑图层/矢量 | Canva Magic Layers / Recraft Vectorize | 生成图拆主体/文字/背景入画布分层;PNG→SVG 进素材库 | P2 | L |

### B. AI 视频与动效(依托:video 任务链/kling 适配器/媒体预览)

| # | 新功能 | 借鉴来源 | 说明与落地 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| 11 | 画布图片右键"生成动态视频" | Runway / Luma | 图生视频入口画布化(链路已有,补右键交互与锚点回填) | P0 | S |
| 12 | 首尾帧补间视频 | Kling / Vidu | 选画布两张图生成过渡镜头,成片回插两锚点之间 | P1 | S |
| 13 | 运镜/转场预设面板 | Pika / 剪映 | 推拉摇移、运镜强度参数化,降低 prompt 门槛 | P1 | S |
| 14 | 视频逐帧截取为素材 | CapCut / Eagle | 播放器选帧→存素材库/设为参考图 | P1 | S |
| 15 | 视频局部重绘与扩边 | Runney Video Inpaint | 指定区域重绘/比例扩展,服务端模型支持时开放 | P2 | M |
| 16 | AI 字幕与口播稿生成 | 剪映 / Whisper | 视频任务自动产出字幕轨(SRT),存入任务结果 | P2 | M |
| 17 | GIF/循环动图导出 | Pika Loop | 视频任务一键转循环 GIF/短视频二维码分享 | P2 | S |
| 18 | 建筑漫游多镜头脚本 | LookX / 即梦 | 工作流引擎编排"分镜→逐段生成→拼接"成漫游片 | P2 | L |
| 19 | 数字人播报 | HeyGen / 腾讯智影 | 看板日报/素材讲解转数字人视频,钉钉推送升级为视频卡 | P2 | L |
| 20 | 屏幕录制→教程片段 | Loom / Canva Record | 内网教学场景录屏讲解画布;【HTTP】getDisplayMedia 需 secure-context,需降级或桌面端 | P2 | M |

### C. AI 音频、语音与音乐(依托:audio 任务链/suno 适配器/播放器)

| # | 新功能 | 借鉴来源 | 说明与落地 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| 21 | 画布/知识库朗读(读稿器) | NotebookLM / Edge 朗读 | speechSynthesis 无 secure-context 限制,内网 HTTP 可用;选中元素/KB 即读 | P0 | S |
| 22 | TTS 配音任务 | ElevenLabs / CosyVoice | 任务队列新增 TTS 类型;开源 CosyVoice/GPT-SoVITS 自建,内网友好 | P1 | M |
| 23 | AI 播客/音频概览 | NotebookLM Audio Overview | 选多份素材/文档生成双人讲解音频,支持钉钉收听 | P2 | L |
| 24 | 音效生成(SFX) | ElevenLabs SFX / Stable Audio | 动效/漫游配乐效,任务队列复用 audio 通道 | P2 | S |
| 25 | 人声/伴奏分离与续写 | Suno stems / Demucs | 现有歌词+生成链路补分轨下载;Demucs 开源自建 | P2 | M |
| 26 | 录音转写与评审纪要 | faster-whisper / FunAsr | 上传录音→转写→KB 纪要(支持说话人分段);录音上传不依赖麦克风 API | P1 | M |
| 27 | 实时语音听写入画布 | Whisper 流式 / 讯飞 | 【HTTP】Web Speech Recognition 需 secure-context,须走服务端流式自建 | P2 | M |
| 28 | 专注音景工作台 | Endel / Suno | 白噪音/氛围乐生成与循环播放,挂媒体库 | P2 | S |
| 29 | 语音指令操作画布 | 各家语音助手 | "撤销/把这组图排成九宫格"→命令面板复用;依赖 27 | P2 | M |
| 30 | 有声画板导出 | Canva Record / Gamma | 画板+配音打包成讲解视频导出 | P2 | M |

### D. 3D 与建筑行业特化(依托:家居/植物库 glb、素材库、爬虫管线)

| # | 新功能 | 借鉴来源 | 说明与落地 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| 31 | 文/图生 3D 模型任务 | Meshy / Tripo API;开源 TRELLIS/Hunyuan3D | 任务队列新增 3D 类型,glb 直入素材库(展示位已有) | P0 | M |
| 32 | ✅ glb 在线预览与旋转查看(2026-09-28) | three.js / model-viewer | 详情页侧已上线(model-viewer 懒加载/进度/降级/插入视角);**画布 3D 视口转二期**(需元素-资产关联) | P0 | M→已完成 |
| 33 | 草图→AI 实景渲染 | PromeAI / Veras / LookX | 建筑刚需主打功能;线稿/白模截图→效果图,适配器扩展 | P0 | M |
| 34 | PBR 材质库与材质球预览 | PolyHaven / AmbientCG | 素材库新增材质分类(贴图组+球预览),爬虫管线复用 | P1 | M |
| 35 | glb 实测尺寸标注 | three.js bbox | 详情页显示模型真实长宽高(与上游 size_text 校验) | P1 | S |
| 36 | 住宅平面 AI 生成 | Maket / ARCHITEChTURES | 约束式(面宽/朝向/房间数)出平面初稿 | P2 | L |
| 37 | 体量/指标快速拟合 | TestFit | 容积率/户数驱动的楼型批量比选 | P2 | L |
| 38 | 环境分析轻量版(日照/风) | Autodesk Forma | 内网简化版日照模拟,画布场地元素联动 | P2 | L |
| 39 | 3D 场景摆贴组合 | Spline / SU 库 | 3D 视图中拖入多个 glb 组合成场景快照回贴画布;最简形态已随 #32 交付(单模型当前视角截图入画布),多模型组合场景为本条目标 | P2 | L |
| 40 | 全景图/720° 漫游导出 | Kuula / Enscape | 渲染结果转全景热点页,内网链接分享 | P2 | M |

### E. 画布编辑与白板体验(依托:Plait/drawnix 元素体系、命令面板)

| # | 新功能 | 借鉴来源 | 说明与落地 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| 41 | 选中元素 AI 操作菜单 | Canva 右键 AI | 选中图片→"抠图/扩图/变体/动起来/去背景"快捷菜单(挂 A/B 类能力) | P0 | S |
| 42 | 提示词→思维导图/流程图 | Excalidraw AI / Xmind Copilot | LLM 输出转 mindmap/connector 元素(元素类型已有) | P0 | M |
| 43 | 画布版本历史与恢复点 | Figma / Excalidraw | 持久化快照时间轴,云同步已有通道,补版本 UI | P1 | M |
| 44 | AI 便签聚类与主题总结 | FigJam AI / Miro Assist | 工坊场景便签自动归类+LLM 总结成卡 | P1 | M |
| 45 | 便签/投票/计时器工作坊件 | FigJam | 便签元素+投票+大计时器,部门评审会用 | P1 | M |
| 46 | 智能对齐与一键整理 | Miro Tidy-up | 选区网格化/等距排列/自动换行 | P1 | S |
| 47 | 草图→可运行原型(Make Real) | tldraw Make Real | 手绘 UI→HTML 预览,内置工具 iframe 已有壳 | P1 | L |
| 48 | 多页/画板页管理 | Figma Pages / PPT | 正式多页+页序+页模板,fitPPT 升级 | P1 | M |
| 49 | 语义化框选与批量属性筛选 | Eagle / Figma 选择集 | "选中所有竖版图片/红色元素/未归档图" | P2 | S |
| 50 | 截图/图片→可编辑图示 | Napkin / Eraser | 图片转架构图/流程图(先 OCR 后图示化) | P2 | L |

### F. 协作、分享与汇报(依托:云同步/看板/钉钉推送)

| # | 新功能 | 借鉴来源 | 说明与落地 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| 51 | 画板一键生成汇报 PPT | Gamma | 大纲+画板图自动组稿,现有 fitPPT 基础;汇报口径(×6)场景刚需 | P0 | M |
| 52 | 只读分享链接(可加水印/有效期) | Excalidraw / Figma view | ai-outputs 公开桶直链已打通,补画板快照页+水印 | P1 | M |
| 53 | 元素级评论与@提醒 | FigJam / Figma | 画布元素挂评论,钉钉机器人通知被@人 | P1 | M |
| 54 | 演示模式与聚光灯 | Miro Present | 全屏放映/跟随讲解者/黑屏聚焦 | P1 | S |
| 55 | 导出增强(高清 PNG/SVG/多页 PDF) | Excalidraw 导出 | 补格式与清晰度选项、水印开关 | P1 | S |
| 56 | 实时多人协同编辑 | Yjs + y-websocket(自托管) | 元素级 OT/CRDT;现有同步引擎保留为离线层,大工程分期 | P2 | L |
| 57 | 在线状态与跟随光标 | Figma Multiplayer | 依赖 56 的实时通道 | P2 | M |
| 58 | 钉钉互动卡片(评论/审批回传) | 钉钉开放平台 | 推送卡可点赞/评论,回调写回画板评论 | P2 | M |
| 59 | 设计评审留档 | BIM 360 | 评审会议:截图+批注+结论自动归档 KB,署名留痕 | P2 | M |
| 60 | 只读画板嵌入部门门户 | ComfyUI Embed / Notion Embed | iframe 只读视图+自动刷新,内网门户集成 | P2 | S |

### G. 素材库与模板中心(依托:official-library/素材库/模板中心/爬虫)

| # | 新功能 | 借鉴来源 | 说明与落地 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| 61 | 以图搜图(上传/框选找同款) | Eagle / Google Lens | CLIP 向量+pgvector(自托管 Supabase 可启),素材库+模板中心通用 | P0 | L |
| 62 | AI 自动打标与智能检索 | Immich / PhotoPrism | 入库流水线加打标任务(主体/风格/色调),搜索框语义化 | P1 | M |
| 63 | 模板"改词复用" | Canva Magic Switch | 模板详情页一键复制参数到输入框并保留参考图;🚧 参考图进输入框链路已上生产(2026-09),一键复制参数待补 | P1 | S |
| 64 | 用户投稿模板流(上传+审核) | LiblibAI 社区 | 模板中心补投稿入口与管理员审核,likes/usage 已有 | P1 | M |
| 65 | 收藏夹多级与智能收藏夹 | Eagle folders | favorites 升级为可分组+规则自动归集 | P2 | S |
| 66 | 素材相似推荐 | Eagle Similar | 详情页"找相似"(向量同 61) | P2 | S |
| 67 | 素材用量反查(谁在用这张图) | Digital Asset Mgmt | 画布/任务引用关系入账,详情页显示引用次数与看板联动 | P2 | S |
| 68 | 配色方案生成与抽取 | Coolors / Khroma | 从素材/画布取色生成配色卡,收藏进色板库 | P1 | S |
| 69 | 素材库周报(爬虫新入库/分类覆盖) | 钉钉机器人已有 | 每周新素材/新分类自动推送钉钉 | P2 | S |
| 70 | 视觉去重与相似合并 | Immich Dedupe | 归档 sha256 已有,补感知相似(pHash)合并建议 | P2 | M |

### H. AI 工作流、自动化与 Agent(依托:workflow-engine/MCP/任务队列)

| # | 新功能 | 借鉴来源 | 说明与落地 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| 71 | 节点式生图流水线编辑器 | ComfyUI / Dify | 工作流引擎已有执行内核,补画布节点编排 UI(拖节点连线) | P1 | L |
| 72 | 画布 Agent(对话式操作) | tldraw Agent / AFFiNE | "把这组图排九宫格/全部放大 2x/换风格重出"→工具调用,initTool 通道已有 | P1 | L |
| 73 | MCP 服务端(画布暴露给外部 Agent) | Excalidraw-MCP | 本项目已是 MCP 客户端,反向暴露"读画布/插元素/跑生成"工具 | P1 | M |
| 74 | 成本/余额感知自动路由 | OpenRouter / OneAPI | fallback 链按价目(tu-zi 已接)与余额自动排序切换 | P1 | S |
| 75 | 用户级定时生成任务 | n8n / cron | "每天 9 点出 4 张方案图推钉钉";定时任务基建已有 | P1 | M |
| 76 | 生成参数快照(PNG 内嵌+拖回复现) | ComfyUI metadata / MJ | 出图参数写 PNG 元数据,拖回画布一键复现/改参重跑 | P1 | S |
| 77 | Webhook 入口(企业 OA 触发生成) | Zapier / n8n | 服务端接 webhook→建任务→钉钉回执,内网 OA 集成 | P2 | M |
| 78 | 失败任务智能诊断与自愈建议 | dev-monitor 已有归因 | 失败时给用户可读原因+一键切换模型重试 | P2 | M |
| 79 | 工作流市场(流水线模板) | Dify 工作流市场 | 节点流水线(71)做成模板分发,复用模板中心 | P2 | M |
| 80 | 多任务编排视图(依赖 DAG) | Airflow 轻量版 | 任务队列可视化依赖与批进度(批量插入已有 batchId) | P2 | M |

### I. 知识库、RAG 与文档智能(依托:KB notes/素材库/归档桶)

| # | 新功能 | 借鉴来源 | 说明与落地 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| 81 | 画板/素材智能摘要卡 | AFFiNE / Notion AI | AI 总结画板内容生成 KB 卡片(图纸说明/要点) | P1 | S |
| 82 | 素材问答(RAG) | NotebookLM / Open WebUI | "找适合现代客厅的沙发素材"→向量检索+引用溯源(pgvector 同 61) | P1 | L |
| 83 | KB 内 AI 写作(续写/润色/翻译) | Notion AI / AFFiNE | LLM 已接,补编辑器内嵌菜单 | P1 | S |
| 84 | 图片 OCR 入 KB | PaddleOCR / MinerU | 截图/规范页文字提取,可搜可引 | P1 | M |
| 85 | PDF/DWG 导入画板 | Spline / 各 CAD 工具 | PDF 页转画板图片组;DWG 先做轻解析缩略(完整解析远期) | P1 | M |
| 86 | KB 与画板双向链接 | Logseq / Obsidian | 画板可引用 KB 块,KB 可嵌入画板缩略 | P2 | M |
| 87 | 网页剪藏 | Notion Clipper / Eagle | iframe 工具已有,补"剪藏到 KB"浏览器入口 | P2 | M |
| 88 | 国标图集/规范知识库 | 建筑行业特化 | 爬虫管线复用建"图集规范库",检索跳转条文的图示页 | P2 | L |
| 89 | 语义去重(知识条目/素材名) | Immich | 重复 KB 卡与近似命名素材的合并建议 | P2 | S |
| 90 | 多语言素材标签 | DeepL / 火山 | 素材/模板标签中英对照,搜索跨语言命中 | P2 | S |

### J. 平台基建、管理与多端(依托:看板/SW/auth/备份恢复/CI)

| # | 新功能 | 借鉴来源 | 说明与落地 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| 91 | 个人用量报告与额度告警 | OneAPI / OpenRouter | 看板已有部门口径,补"我的本月用量"+80% 钉钉告警 | P1 | M |
| 92 | 任务成功率/耗时个人看板 | dev-monitor | 用户侧"我的生成报告"(成功率/平均耗时/常用模型) | P1 | S |
| 93 | 快捷键中心与自定义 | Figma / Vimium | 快捷键速查卡+用户自定义映射 | P1 | S |
| 94 | 全量数据导出/迁移包 | Obsidian Export / 备份恢复 | backup/restore 已有,补跨设备迁移包(画板+KB+素材清单) | P1 | S |
| 95 | 桌面壳(Electron)离线版 | AFFiNE Desktop | 彻底解决 HTTP 非 secure-context 限制(SW/麦克风/录屏全解锁) | P2 | L |
| 96 | 平板/触屏优化 | Freeform / tldraw | 触控手势、浮动手写笔、移动布局 | P2 | L |
| 97 | 操作审计日志 | GitLab Audit | 删除/导出/权限变更留痕,管理端可查 | P2 | M |
| 98 | 企业 SSO(OA/LDAP/CAS) | 企业常见 | 现 OA 账号体系上接标准 SSO | P2 | M |
| 99 | UI 多语言全量化 | 各家 | i18n 骨架已有,en 全量+切换入口 | P2 | M |
| 100 | 自建 GPU 生成节点 | ComfyUI 后端 / Liblib | fallback 适配器接自建 ComfyUI/SD 节点,降本内网化 | P2 | L |

## 三、使用建议

1. **Top 10 快赢组合(建议一个季度内)**:#41 选中即 AI(交互壳)→ #1 局部重绘 → #3 放大 →
   #2 多模型对比 → #11 右键生成视频 → #21 朗读 → #42 提示词→导图 → #51 一键 PPT →
   #31 图生 3D → #33 草图渲染。共同点:全部长在现有任务队列/素材库/模板中心骨架上,
   无需新基建。(#32 glb 预览原属本清单,已提前于 2026-09-28 完成——顺带打通了
   ai-outputs 桶直链插入与编辑器降级基建,#31/#39 可直接复用该展示与交付链路。)
2. **两条主线**:「建筑专业深度」(#6/#31/#33/#34/#36-40,对标 PromeAI/LookX/Forma)与
   「AI 画布深度」(#5/#41/#71/#72,对标 Krea/tldraw)——前者赢得用户,后者赢得口碑。
3. **基建先行项**:#61 的 pgvector 一次投入(#62/#66/#82 三条复用);#56 实时协同是
   #57/#58 的前置,动工前先拍板。
4. **红线提醒**:标【HTTP】条目(#20/#27)依赖 secure-context API,内网明文 HTTP 下不可
   直接用;若离线/移动/语音是刚需,#95 桌面壳是总解。所有云 API 引入前先过「内网可达
   或自建开源替代」评估。

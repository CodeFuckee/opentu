# 技术方案:#32 glb 在线预览与旋转查看(3D 预览)

> 2026-09-28 · grill-me 拷问后定稿 · 对应 docs/new-feature-plan-100.md #32(P0/M)
> 状态:**待拍板实施**

## 一、已拍板决策(2026-09-28)

| 决策点 | 结论 |
|---|---|
| 渲染技术 | **@google/model-viewer**(新增依赖已拍板;npm 打包,不用 CDN) |
| 本期范围 | **仅详情面板入口**(素材库 Inspector + 官方库详情);画布侧(元素-资产关联)二期 |
| 承载形态 | **全屏 Dialog**(复用 tdesign Dialog,关闭即卸载释放 WebGL 上下文) |
| 加载降级 | **进度条 + >20MB 打开前确认 + 30s 超时/失败降级**(视图图 + 下载 glb 引导) |

## 二、现状事实(摸底结论)

- 数据:家居库 906 行 / **818 行有 glb**(均值 4.3MB,最大 45.1MB);植物库 463 行 / 9 行有 glb
  (生产库 2026-09-28 实测)。两表同构,`glb_path` → 公开桶直链
  `productModelPublicUrl()` 已有(official-library-service.ts)。
- 资产链:`Asset.homeMeta.glbUrl/glbName` 已通到素材库详情面板
  (MediaLibraryInspector「3D 模型」行目前只有"下载 glb"链接);官方库详情同源。
- 环境约束:内网 **HTTP 部署**——model-viewer 纯 WebGL + fetch,无 secure-context 依赖 ✓;
  禁走 CDN,依赖必须 npm 打包 ✓;AR(WebXR)不启用(HTTP 不可用且无需求)。
- 工程:项目零 3D 依赖;`React.lazy` 懒加载先例(tool-adapters.tsx);React 18.3.1 +
  tdesign-react 1.14。

## 三、架构设计

```
MediaLibraryInspector(素材库详情)
  └─「3D 模型」行: [3D 预览] [下载 glb]        ← glbUrl 存在时渲染按钮
        │ React.lazy(点击时才加载 chunk)
        ▼
GlbModelViewerDialog(新组件,全屏 Dialog)
  ├─ <model-viewer src={glbUrl} camera-controls auto-rotate .../>   ← 懒 import 注册
  ├─ progress 事件 → 顶部进度条(0-100%)
  ├─ >20MB(HomeAssetMeta.glbBytes) → 打开前 Confirm(显示体积,可取消)
  ├─ 30s 无进度推进 / loaderror → 降级态:视图图组 + 「下载 glb」引导
  └─ 关闭 → Dialog 卸载(model-viewer 随卸载释放 WebGL 上下文)
```

### 3.1 依赖与引入

- `pnpm add @google/model-viewer`(唯一新依赖,自带 three;无其他传递新增)。
- **不进主包**:GlbModelViewerDialog 整体 `React.lazy`;vite 按动态 import 自动切独立
  chunk(model-viewer+three ~1MB gz 只在被点击时下载,内网秒级)。
- React 18 + web component:组件内 `import '@google/model-viewer'` 注册 custom element;
  TSX 需声明 JSX 内在元素类型(新 `types/glb-viewer.d.ts`:IntrinsicElements['model-viewer']);
  `camera-controls` 等属性直接 JSX 属性透传;`progress`/`load`/`error` 事件用 ref +
  addEventListener(CustomEvent 细节 React 合成事件不可靠,统一原生监听,卸载时移除)。

### 3.2 组件与状态机

`GlbModelViewerDialog` props:`{ glbUrl: string; glbName?: string; glbBytes?: number;
viewImageUrls?: string[]; onClose: () => void }`

状态机:`confirm-large`(>20MB 首次打开)→ `loading`(进度<100)→ `ready` ⇄
`fallback`(超时/失败,展示 viewImageUrls + 下载引导)。进度 30s 无推进即判超时。
renderer-config 用默认;`auto-rotate` 打开、`camera-controls` 开、`touch-action: pan-y`
(移动端预留,本期桌面)。

### 3.3 入口接线(两处,同一按钮)

- MediaLibraryInspector「3D 模型」元数据行:`下载 glb` 旁加 `3D 预览` 按钮
  (`homeMeta.glbUrl` 存在时);i18n 补键(zh/en)。
- 官方库详情(OfficialLibraryView)同源 homeMeta,接同一按钮组件。
- 家居库与植物库**自动同时生效**(两表同构映射,无需分支)。

### 3.4 数据补一个字段

`HomeAssetMeta` 增 `glbBytes?: number | null`:
- official-library-service 两处 row 映射加 `glb_bytes: row.glb_bytes`;
- 查询列(glb select)补 `glb_bytes`;
- 大文件确认的体积提示与测试阈值用。

### 3.5 HTTP/部署红线核对

| 约束 | 结论 |
|---|---|
| 非 localhost HTTP 可用 | WebGL/fetch 无 secure-context 要求 ✓;不用 CDN ✓ |
| SW 未注册时可用 | 预览不依赖 SW(公开桶直链直取)✓ |
| 主包体积 | 动态 chunk,主 bundle 零增长 ✓ |
| CSP | model-viewer 无外链资源,不触现有 CSP ✓ |

## 四、测试与验收

- 单测(新增,不依赖 model-viewer 实体):降级状态机纯函数(超时判定/大文件阈值);
  glbBytes 映射(official-library-service 行→Asset);Inspector 按钮
  glbUrl 有/无渲染分支。target:新增 ~10 例。
- E2E(1 条 smoke,挂 official-library 相关 spec):打开家居库详情 → 点 3D 预览 →
  model-viewer 元素出现(有 src)→ 关闭。真实渲染走用户过目。
- 手动过目(必须):家居库任一 glb(小/大各一)在 **http://10.37.80.175:7289 内网
  地址**下旋转/缩放流畅、进度可见、大文件确认、超时降级。
- 验收标准:点「3D 预览」≤2s 出视口;818 个家居 glb 任意一个可旋转查看;
  断网/坏 URL 落降级态不白屏;主 bundle 体积不变(CI 产物对比)。

## 五、工作量与风险

分解(总 M,~2.5-3 天):依赖+Dialog 骨架+懒加载 0.5d → 进度/超时/降级状态机 1d →
两处入口接线+i18n+glbBytes 字段 0.5d → 单测+E2E+内网过目 1d。

风险与对策:
1. **React18 + web component 事件绑定坑**(属性 camelCase/事件 CustomEvent)——统一 ref+
   原生监听,不做 JSX 事件;先做 spike 半天验证再铺开。
2. **45MB 大文件内存峰值**——打开前确认 + 降级路径;不过度工程(不做分片/LOD)。
3. **并行会话冲突**——MediaLibraryInspector/official-library-service 近期无在途改动;
   动工前仍按惯例 `git status` 复核。

## 六、明确不做(本期)

- 画布 3D 视口、画布右键查看原模型(元素-资产关联,二期单独立项);
- AR/WebXR;glb 编辑/测量(见 #35,#38);预加载/批量缓存。

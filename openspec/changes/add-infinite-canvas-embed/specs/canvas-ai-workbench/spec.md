## ADDED Requirements

### Requirement: 无限画布工作台嵌入

平台 SHALL 以独立子应用形态整包嵌入上游 infinite-canvas（React 19 技术栈隔离），
其构建产物 MUST 部署于平台同域 `/infinite/` 静态子路径，由生产静态服务器直接
伺服，不引入任何后端进程或反向代理变更。

#### Scenario: 子路径直达

- **WHEN** 用户在浏览器直访 `/infinite/`
- **THEN** 伺服子应用自身 index.html（非主应用壳），画布工作台正常渲染

#### Scenario: 深链刷新

- **WHEN** 用户在子应用任意 hash 深链（如 `/infinite/#/config`）刷新页面
- **THEN** 页面由静态服务器正常返回子应用入口并由前端路由接管，不出现 404

### Requirement: 主应用入口与宿主页

主应用 SHALL 提供「无限画布 ↗」入口（工具箱 AI 工具分区），点击后打开
`/canvas-ai` 宿主页；宿主页 MUST 位于 AuthGate 之后，以全屏 iframe 承载
`/infinite/` 并提供返回主画布的导航。

#### Scenario: 工具箱入口全链路

- **WHEN** 已登录用户在主应用工具箱 AI 工具分区点击「无限画布 ↗」
- **THEN** 新上下文打开 `/canvas-ai`，宿主页 iframe 内子应用顶栏可见

#### Scenario: 返回画布

- **WHEN** 用户在 `/canvas-ai` 宿主页点击「← 画布」
- **THEN** 整页回到主应用且画布可见，不触发崩溃恢复误报

### Requirement: 主应用首屏与缓存零影响

子应用 MUST NOT 被纳入主应用 Service Worker 的预缓存/预取清单，其静态导航
请求 MUST NOT 被主应用 app-shell 策略截胡；主应用首屏资源体积 MUST 因嵌入
零增量。

#### Scenario: SW 不吞子应用导航

- **WHEN** 已注册主应用 SW 的页面对 `/infinite`、`/infinite/`、`/infinite/#/x`
  发起导航请求
- **THEN** SW 不采用 app-shell 策略，请求直达静态子应用

#### Scenario: 预缓存排除

- **WHEN** 主应用构建生成 precache-manifest.json
- **THEN** 清单中不含 `infinite/` 子目录下的任何子应用资源

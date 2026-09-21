# official-material-library 规格（delta）

## ADDED Requirements

### Requirement: 素材库面板提供官方素材库模式

素材库面板（MediaLibraryModal）主区顶部 SHALL 提供「我的素材 / 官方素材库」双模式切换；
官方素材库模式下 SHALL 隐藏个人素材的类型 tab（全部/图片/视频/音频）与标签/主体/本地/AI
筛选，个人素材模式的既有行为不受影响。

#### Scenario: 切换到官方素材库

- **WHEN** 用户在素材库面板点击「官方素材库」
- **THEN** 主区渲染官方库视图：搜索框、库 tab、分类 chips、tag chips、素材网格、页脚计数
- **AND** 个人素材的类型 tab 与来源/类别筛选不可见

#### Scenario: 宿主未接入时优雅降级

- **WHEN** 官方素材库运行时未注册（未登录或宿主未调用 configureOfficialLibrary）
- **THEN** 官方模式显示空态提示而非报错

### Requirement: 按建筑学长三级分类展示

官方素材库 SHALL 按 `jzxz_materials` 的 gallery → category → tag 三级分类组织筛选：
库 tab 按定制顺序（家居库/植物库/配景库优先）排列；仅当所选库存在分类时显示分类 chips；
选中分类后显示该分类下的 tag chips。计数为 0 的分类与 tag SHALL NOT 渲染。

#### Scenario: 配景库两级分类

- **WHEN** 用户选中「配景库」tab
- **THEN** 显示该库实际存在的分类 chips（如 植物配景/自然环境），选中分类后显示其 tag chips
- **AND** 爬虫尚未爬到的分类（当前 0 条）不出现在 chips 中

#### Scenario: 无分类库直选

- **WHEN** 用户选中「家居库」或「植物库」tab
- **THEN** 不显示分类与 tag 行，网格直接展示该库全部素材

### Requirement: 服务端分页与懒加载

官方素材网格 SHALL 采用服务端分页（每页 60 条，`count=exact` 取总数），滚动近底部时
自动加载下一页并追加展示；排序 SHALL 为 `created_at desc, id asc`（稳定 tiebreaker，
翻页不重不漏）。facets（库/分类/tag 组合）SHALL 分页扫描后客户端去重并做模块级缓存。

#### Scenario: 滚动加载更多

- **WHEN** 当前筛选结果总数大于已加载数且用户滚动近网格底部
- **THEN** 自动请求下一页并追加到网格尾部

#### Scenario: 筛选变化重置分页

- **WHEN** 用户切换库/分类/tag 或输入搜索词
- **THEN** 网格重置到第一页并按新筛选加载

### Requirement: 官方素材只读、URL 直插

官方素材 SHALL 以公开桶直链（`/storage/v1/object/public/jzxz-materials/{path}`）展示与
插入，SHALL NOT 复制进个人素材库（不写 IndexedDB、不计个人配额、不可重命名/删除/设为
主体）。BROWSE 模式双击预览、预览器可插入画布；SELECT 模式「使用」将直链返回宿主回调。
官方模式 SHALL 提供按素材名/tag 的服务端 `ilike` 搜索。

#### Scenario: SELECT 模式使用官方素材

- **WHEN** 用户在 SELECT 模式下双击或点击「使用」官方素材
- **THEN** 宿主 onSelect 收到该素材（url 为公开桶直链），面板关闭

#### Scenario: 只读约束

- **WHEN** 用户选中一条官方素材查看详情
- **THEN** 详情面板不提供重命名/删除/设为主体操作，保留下载与（SELECT 模式）使用

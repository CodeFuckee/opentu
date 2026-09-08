## ADDED Requirements
### Requirement: Feedbackland 反馈入口
左侧工具栏 SHALL 在底部固定区提供 Feedbackland 反馈入口按钮，点击后在新标签页打开
自部署 Feedbackland 实例地址（配置常量 `FEEDBACKLAND_URL`，默认指向项目仓库页）。

#### Scenario: 点击 Feedbackland 按钮跳转
- **WHEN** 用户点击侧边栏底部的 Feedbackland 按钮
- **THEN** 浏览器以新标签页打开 `FEEDBACKLAND_URL`（`target=_blank` 且带 `noopener`）

#### Scenario: 部署自建实例后切换地址
- **GIVEN** 用户已自部署 Feedbackland 实例
- **WHEN** 将 `FEEDBACKLAND_URL` 常量替换为实例地址
- **THEN** 按钮跳转目标更新为实例地址，无需改动其他代码

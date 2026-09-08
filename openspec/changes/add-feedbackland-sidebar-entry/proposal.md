# Change: 侧边栏新增 Feedbackland 反馈入口按钮

## Why
用户需要一个直接进入 Feedbackland 反馈平台的入口。Feedbackland 是开源的客户反馈收集
工具（https://github.com/feedbackland/feedbackland），支持自部署。当前应用只有右下角
"用户反馈群"二维码按钮，缺少一个跳转到 Feedbackland 平台的入口。

## What Changes
- 新增常量 `FEEDBACKLAND_URL`（`packages/drawnix/src/constants.ts`），作为自部署实例
  地址的单一配置点；默认指向 Feedbackland 开源仓库页，部署自建实例后替换该常量即可。
- 新增 `FeedbacklandIcon` 图标（`packages/drawnix/src/components/icons.tsx`）。
- 在 `BottomActionsSection`（左侧工具栏底部固定区，与"打开项目/工具箱/任务队列"并列）
  新增 Feedbackland 按钮，点击后通过 `window.open(FEEDBACKLAND_URL, '_blank',
  'noopener,noreferrer')` 在新标签页打开。
- 新增组件单元测试 `bottom-actions-section.test.tsx`（渲染、跳转参数、弹窗被拦截、
  URL 合法性、原有按钮回归）。

## Impact
- Affected specs: toolbox
- Affected code: packages/drawnix/src/constants.ts、components/icons.tsx、
  components/toolbar/bottom-actions-section.tsx

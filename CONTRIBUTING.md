# 贡献指南 Contributing Guide

感谢你关注 Yue画布。这个仓库使用 pnpm + Nx 管理 Web 应用、画布核心库和 E2E 测试。

[English](#english) | [中文](#中文)

## 中文

### 开发环境

- Node.js 20+
- pnpm 10.21.0

```bash
git clone https://github.com/YOUR_USERNAME/aitu.git
cd aitu
corepack enable pnpm
pnpm install
pnpm start
```

开发服务默认运行在 `http://localhost:7200`。

### 常用验证

```bash
pnpm check             # typecheck + lint
pnpm test              # 单元测试
pnpm e2e:smoke         # 冒烟测试
pnpm check:cycles      # 循环依赖检查
pnpm build:web         # Web 构建
```

### 提交规范

提交信息遵循 Conventional Commits：

```text
feat(scope): 添加能力
fix(scope): 修复问题
docs: 更新文档
refactor(scope): 重构实现
test(scope): 补充测试
chore: 调整工具或配置
```

### Pull Request 要求

- 说明问题、修复思路和影响范围。
- 涉及 UI 时附截图或录屏。
- 涉及数据迁移、缓存、文件处理或同步逻辑时说明兼容策略。
- 不提交生成产物、临时测试文件、依赖目录或本地环境文件。
- 保持改动聚焦，避免把无关格式化混入 PR。

## English

### Development Environment

- Node.js 20+
- pnpm 10.21.0

```bash
git clone https://github.com/YOUR_USERNAME/aitu.git
cd aitu
corepack enable pnpm
pnpm install
pnpm start
```

The dev server runs at `http://localhost:7200`.

### Common Checks

```bash
pnpm check             # typecheck + lint
pnpm test              # unit tests
pnpm e2e:smoke         # smoke E2E tests
pnpm check:cycles      # circular dependency check
pnpm build:web         # Web build
```

### Commit Convention

Use Conventional Commits:

```text
feat(scope): add capability
fix(scope): fix issue
docs: update documentation
refactor(scope): refactor implementation
test(scope): add tests
chore: update tooling or config
```

### Pull Request Checklist

- Explain the problem, approach, and impact.
- Include screenshots or recordings for UI changes.
- Document compatibility for migrations, cache, file processing, or sync changes.
- Do not commit generated artifacts, temporary test files, dependency folders, or local environment files.
- Keep the PR focused and avoid unrelated formatting churn.

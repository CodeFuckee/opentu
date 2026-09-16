# E2E 测试报告（素材库对话框图片可见性，2026-09-16）

- 运行环境：
  - 命令：`npx playwright test --project=auth-setup --project=functional src/functional/media-library-images.spec.ts`（cwd：`apps/web-e2e`）
  - 浏览器：Desktop Chromium（Playwright `functional` 项目，无头 headless）
  - 被测服务：Playwright 自动拉起 `npx nx serve web`（dev server，http://localhost:7200，reuseExistingServer）
  - 认证：`auth-setup` 以固定测试账号池（按 worker 分配，本次 worker 0 → e2e_sync_a）登录并复用 storageState
  - Supabase 后端：http://10.37.80.25:8021（可达）
- 结果统计：总 5 条（另有 1 条 auth-setup 前置）| 通过 5 | 失败 0 | 跳过 0 | 耗时：首轮 49.6s（含 dev server 冷启动）/ 复跑 18.1s（server 复用）
- 失败分析（逐条）：无失败项。
- 覆盖评估：计划 5 条用例（E2E-101 ~ E2E-105）全部实现并执行，无未覆盖项。
  - E2E-101（P0）单张上传 → 网格 `img.lazy-image__img` 可见且 `naturalWidth > 0`、无「加载失败」错误态、「图片」类型计数 +1 ✅
  - E2E-102（P1）批量上传 3 张 → 搜索过滤后 3 项全部解码成功 ✅
  - E2E-103（P1）双击预览 → `.unified-viewer` 大图 `img.media-viewport__image` 解码成功，可关闭回到网格 ✅
  - E2E-104（P1）刷新持久化 → reload 后重新打开素材库，图片仍解码成功（IndexedDB 元数据 + SW `/__aitu_cache__/` 缓存回放正常）✅
  - E2E-105（P2）视图切换 → 紧凑/列表视图下图片均解码成功，列表模式素材名可见 ✅
  - 断言标准均为「用户可见行为」层面：图片真实解码（`naturalWidth > 0`）而非仅元素存在；错误态（`.lazy-image__error`「加载失败/点击重试」）必须为 0。
- 稳定性评估：
  - 连续完整重跑 2 轮，结果一致（5/5 通过），无 flaky。
  - 第 2 轮同时验证了数据清理幂等性：afterEach「搜索前缀 → 批量选择 → 删除 → 确认」在同一测试账号上重复执行无残留、无干扰。
  - 测试数据唯一前缀（`e2eimg<runid>`）+ 用例内自清理，账号内无累积污染。
- 附带质量信号：测试全程挂接 console error 监听（项目 `test-base` fixture，任何 console error 即失败），2 轮运行均无 console error，说明上传/预览/删除全链路无报错。
- 结论：**素材库对话框的图片在各场景下均能正常可见**（网格、批量、预览大图、刷新持久化、视图切换），通过标准已达成。
- 后续：进入确认门 2 —— 用户有头浏览器亲手运行确认（注意：Playwright 文件参数按正则匹配，
  Windows 反斜杠路径中 `\f` 会被解析为换页符转义导致「No tests found」，须用纯文件名子串过滤）：
  ```
  cd apps\web-e2e
  npx playwright test --project=functional media-library-images --headed
  ```

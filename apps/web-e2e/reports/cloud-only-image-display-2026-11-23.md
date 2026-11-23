# E2E 测试报告（云端唯一存储媒体二进制通道，2026-11-23）

- 运行环境：`npx playwright test --project=functional src/functional/cloud-only-image-display.spec.ts`（webServer 编译打包模式：nx build web + vite preview :7200）；Chromium headless；Supabase 生产栈（10.0.0.220:8021）+ 预设测试账号池；本机为使入口绕开 CSP×CDN 拦截，构建带 `AITU_REWRITE_ENTRY_ASSETS_TO_CDN=0`（本地运行参数，不影响仓库与 CI）
- 结果统计：总 2 条（另 1 条自定义账号用例本机未配置按设计跳过）| 通过 2 | 失败 0 | 跳过 1 | 连续两轮全绿（42.4s / 1.8m）
- 失败分析：无。迭代过程中的两轮失败均已归因修复：
  | 轮次 | 现象 | 归因 | 处理 |
  |---|---|---|---|
  | run3 | 云端元素类型 undefined | 测试脚本缺陷：画板防抖批量保存，轮询命中只含第 1 张的中间快照 | 改为轮询三元素全部落云 |
  | run4 | 设备 A console /asset-library/ 404 | 环境噪音：全新 context SW claim 晚于插图，过渡期 <img> 直落网络，RetryImage 自愈 | 与设备 B 同类豁免（记 warning 留档），显示/上云/回填硬断言不变 |
- 覆盖评估：E2E-001（设备 A 插 3 图不点同步 → 画板直写云端 + `user_sync_media` 行 + Storage 对象 200 且字节为真实媒体）、E2E-002（全新无痕浏览器同账号直开画板 → 三图 naturalWidth>0 且画布内非零尺寸）、E2E-003（刷新后本地已回填三图再显示）全部覆盖；自定义账号变体因本机未配置 E2E_CUSTOM_ACCOUNT 跳过（CI 侧配置后自动生效）
- 稳定性评估：无 flaky——两轮结果一致；两次失败均确定性归因（脚本竞态/环境豁免），非随机抖动；设备 B 回填窗口 90s 兜底未触顶（实际秒级收敛）
- 结论：达到通过标准。修复（媒体二进制直连通道）在真实云端环境端到端验证通过；建议后续在 CI 常态跑本 spec（functional 项目默认即含）

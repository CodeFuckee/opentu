# 建筑学长贴图素材库爬虫（jzxz-material-crawler）

本机 selenium 无头浏览器爬取建筑学长贴图素材库（家居/植物/配景），图片转存
Supabase 公开桶 `jzxz-materials`，元数据 upsert 到表 `jzxz_materials`。
真实页面自行完成接口签名，**无需逆向签名算法**（wallpaper.soutushenqi.com
网关的签名与 community 网关不同源且含时间因子，已放弃逆向改走 UI 驱动）。

## 架构

```
无头 Chrome（专用 profile，会话持久化）
  → 打开 www.jianzhuxuezhang.com/home → 关推广弹窗
  → 点「本地上传」格子 → 塞探针图 → 编辑对话框（右侧贴图面板）
  → 页面注入 fetch/XHR 钩子（捕获 wallpaper/reference 响应）
  → 遍历 分类行(first_cate_list, 11 类) → tag 行(sub_cate_list, 箭头滚动全量收集)
  → 逐 tag 点击翻页；双通道收割：
     ① 网络捕获（首次浏览的 tag 发真实请求）
     ② DOM 网格收割（命中应用内存/localStorage 缓存时无请求，直接收割渲染出的 img）
  → 图片按 {分类}/{md5}.{ext} 内容寻址上传桶（upsert 幂等）
  → 元数据按 source_id upsert 表（翻页乱序无影响）
```

- 面板按 tag 记忆翻页位置：点击 tag 不一定回到第 0 页，脚本为事件驱动收割
  （等任意新响应、按 tag 归账），乱序页靠 source_id 去重，不影响覆盖。
- 网格图片可能在 iframe/shadow DOM：收割为文档级扫描，域名过滤
  `image(-assets)?.soutushenqi.com`。
- 已知素材无名称字段（响应仅 largeUrl/thumbUrl/width/height），
  source_id 取 URL 内 UUID 文件名。

## 首次部署

1. 执行迁移：`cat supabase/migrations/jzxz_materials.sql | ssh mdc@10.37.80.25 "docker exec -i supabase-db psql -U supabase_admin -d postgres"`
2. 复制 `scripts/jzxz-crawler.local.json.example` → `scripts/jzxz-crawler.local.json`，
   填入 `service_key`（service_role，gitignored 不会入库）
3. 首次验证：`python scripts/jzxz-material-crawler.py --dry-run --headed --max-pages 2`
4. 全量首爬：`python scripts/jzxz-material-crawler.py`（无头，时长视总量，可能小时级）
5. 定时：ZCode 定时任务每日执行（同模板同步模式）

## 命令

| 命令 | 作用 |
| --- | --- |
| `--dry-run` | 只抓取解析，落 `data/jzxz-captured/captured-*.json`，不上传 |
| `--headed` | 有头浏览器（调试观察） |
| `--login` | 首次登录模式（有头，扫码后自动保存会话到 profile） |
| `--max-pages N` | 每 tag 最大页数（覆盖配置，默认 200） |
| `--categories a,b` | 只爬指定分类 |

## 已知边界

- 上游若把新素材追加到 tag 列表尾部，每日全量翻页可覆盖；配置
  `stop_known_pages>0` 可提前收尾提速，但可能漏尾部新增（默认 0=全量翻页）。
- tag 词表随面板 DOM 而来，上游新增分类/tag 自动跟随，无需改码。
- 素材响应无名称字段，`name` 为空（如需名称需另外的接口）。
- 登录态：实测游客可浏览素材面板（登录弹窗直接关闭即可）；若上游改为
  必须登录，用 `--login` 扫码一次即可（profile 会话长期有效）。

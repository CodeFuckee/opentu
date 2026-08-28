## ADDED Requirements

### Requirement: 任务参数创建时归档到 Supabase

系统 SHALL 在 AI 生成任务（image/video/audio/chat 及分析类）创建时将任务参数异步归档到 Supabase
`task_submissions` 表（status=submitted），并仅在任务归档前保留完整参数。

#### Scenario: 图片生成任务创建即归档

- **WHEN** 用户提交一个包含参考图的图片生成任务
- **THEN** 系统将任务参数（含上传后的文件路径）写入 `task_submissions`，status 为 `submitted`，
  且 `user_id` 为当前登录用户

#### Scenario: 未登录或未注册归档配置

- **WHEN** 宿主未注册归档配置或当前无登录会话
- **THEN** 归档被静默跳过，任务创建与执行不受影响

### Requirement: 文件上传到 huabu bucket 并以路径入库

系统 SHALL 将任务参数中的文件（base64 dataURL 或 File/Blob）上传到 Storage bucket `huabu`，
路径为 `{用户名}/{YYYY-MM-DD}/input-{文件SHA-256}.{扩展名}`，并在数据库参数中以该存储路径替换原 dataURL，
同时在 `file_paths` 字段记录本次上传的路径列表。

#### Scenario: base64 参考图上传

- **WHEN** 任务参数 `uploadedImages` 中包含 base64 dataURL 图片
- **THEN** 该文件被上传到 `{oa账号}/{本地日期}/input-{sha256}.{ext}`，
  `task_submissions.params` 中对应字段变为该存储路径，`file_paths` 包含该路径

#### Scenario: 相同 dataURL 去重

- **WHEN** 同一 dataURL 在参数中出现多次
- **THEN** 只上传一次，所有出现位置都替换为同一存储路径

#### Scenario: http / __aitu_cache__ URL 不重复上传

- **WHEN** 参数中包含 http(s) 或 `/__aitu_cache__/` 形式的图片 URL
- **THEN** 该 URL 原样保留在 `params` 中，不触发上传

#### Scenario: 单个文件上传失败

- **WHEN** 某个文件上传到 huabu 失败
- **THEN** 该 dataURL 原样保留在 `params` 中、不进 `file_paths`，其余文件与参数仍正常入库，归档整体静默失败不抛错

### Requirement: 用户名解析

系统 SHALL 使用 `user_profiles.oa_account` 作为 bucket 目录用户名；当 oa_account 缺失时回退登录邮箱 @ 前缀；
两者都不可用时跳过本次归档。用户名须经清洗（小写 + 仅保留 `[a-z0-9._-]`）。

#### Scenario: oa_account 优先

- **WHEN** 用户 profile 存在非空 `oa_account`
- **THEN** bucket 路径首段使用清洗后的 oa_account

#### Scenario: oa_account 缺失回退邮箱前缀

- **WHEN** oa_account 缺失但用户有登录邮箱
- **THEN** bucket 路径首段使用邮箱 @ 前缀

### Requirement: 终态回写同一行

系统 SHALL 在任务进入终态时按 user_id+task_id 更新 `task_submissions` 同一行：
completed 写入 result 与 completed_at，failed 写入 error 与 completed_at，cancelled 写入 completed_at。

#### Scenario: 任务完成

- **WHEN** 任务状态变为 `completed`
- **THEN** 对应行 status 更新为 `completed`，result 与 completed_at 被写入

#### Scenario: 任务失败或取消

- **WHEN** 任务状态变为 `failed` 或 `cancelled`
- **THEN** 对应行 status 与 error（failed 时）被更新，completed_at 写入

### Requirement: 归档不阻塞生成且静默失败

系统 SHALL 将归档作为 fire-and-forget 后台操作执行；任何异常仅记录 console 警告，绝不抛出、不阻塞任务创建与执行，
也不影响 IndexedDB 任务队列。

#### Scenario: Supabase 不可用

- **WHEN** Supabase 网络错误或接口异常
- **THEN** 任务照常创建并执行，归档失败仅 console 警告
/**
 * supabase-sync 类型定义
 *
 * 云端同步：登录用户把全部本地数据（画板/任务/工作流/提示词/知识库/聊天/音频/角色/素材/设置）
 * 同步到 Supabase（user_sync_data 通用表 + user_sync_media 元数据表 + yue-sync storage 桶）。
 */

/** 可同步的实体类型（与 user_sync_data.entity_type 枚举一致） */
export const SYNC_ENTITY_TYPES = [
  'board',                 // 画板（content = Board）
  'folder',                // 文件夹
  'workspace_state',       // 工作区状态（content = WorkspaceState）
  'prompt',                // 提示词（content = PromptHistoryItem / Video / Image）
  'prompt_deleted',        // 已删除提示词墓碑（content = PromptTombstone）
  'task',                  // 生成任务（content = Task 精简结构）
  'workflow',              // 工作流（content = WorkflowDefinition 精简结构）
  'kb_note',               // 知识库笔记元数据
  'kb_directory',          // 知识库目录
  'kb_tag',                // 知识库标签
  'kb_note_tag',           // 笔记-标签关联
  'kb_note_content',       // 笔记正文
  'kb_note_image',         // 笔记图片（大字段，走媒体同步或 JSON）
  'chat_session',          // 聊天会话
  'chat_message',          // 聊天消息
  'audio_playlist',        // 音频播放列表（含条目）
  'character',             // AI 角色
  'asset',                 // 素材库元数据
  'cache_media',           // 缓存媒体元数据（含素材/AI 生成媒体）
  'settings',              // 应用设置（去除敏感字段）
  'custom_tools',          // 自定义工具
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/** 远程实体键扫描行（轻列，键全量扫描用；不含 content） */
export interface RemoteEntityKey {
  entityType: SyncEntityType;
  entityId: string;
  updatedAt: number;
  deletedAt: number | null;
}

/** 云端一行实体的客户端映射（updated_at 用 epoch ms 便于比较） */
export interface SyncEntity {
  entity_type: SyncEntityType;
  entity_id: string;
  /** 实体内容（JSON 可序列化，不含二进制） */
  content: unknown;
  /** 内容校验和（增量判断） */
  checksum: string;
  /** 最后修改时间（epoch ms） */
  updated_at: number;
  /** 软删除墓碑（null=存在） */
  deleted_at: number | null;
}

/** 同步状态 */
export type SupabaseSyncStatus =
  | 'not_configured' // 未登录/未注册
  | 'synced' // 已同步
  | 'local_changes' // 本地有变更待上传
  | 'syncing' // 同步中
  | 'error'; // 错误

/** 变更比较结果 */
export interface SyncDiffResult {
  /** 需要上传到云端的实体键（entity_type:entity_id） */
  toUpload: string[];
  /** 需要从云端下载的实体键 */
  toDownload: string[];
  /** 双方都修改（冲突）的实体键 */
  conflicts: string[];
  /** 需要在本地删除的实体键（云端已标记墓碑） */
  toDeleteLocally: string[];
  /** 需要在云端删除（标记墓碑）的实体键（本地已删除） */
  toTombstoneRemotely: string[];
}

/** 同步各阶段耗时（ms，openspec improve-sync-performance 阶段计时） */
export interface SyncStageTimings {
  /** 本地快照收集 */
  collectMs: number;
  /** 远程实体拉取 */
  remoteFetchMs: number;
  /** 差异比对 */
  diffMs: number;
  /** 上传本地变更 */
  uploadMs: number;
  /** 下载远程变更（含冲突应用/本地删除/云端墓碑） */
  downloadMs: number;
  /** 总耗时 */
  totalMs: number;
}

/** 单次同步结果 */
export interface SupabaseSyncResult {
  success: boolean;
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  error?: string;
  duration: number;
  /** 各阶段耗时（可用性观测与性能回归对比；极早失败可能缺失） */
  stageTimings?: SyncStageTimings;
}

/** 媒体同步状态 */
export type SupabaseMediaSyncStatus =
  | 'not_synced'
  | 'synced'
  | 'syncing'
  | 'error';

/** 媒体条目（user_sync_media 客户端映射） */
export interface SyncMediaItem {
  url: string;
  type: 'image' | 'video' | 'audio';
  mimeType?: string;
  size?: number;
  storagePath: string;
  updatedAt: number;
}

/** 同步运行时配置（宿主注册） */
export interface SupabaseSyncConfig {
  /** 可用的 SupabaseClient（已登录会话） */
  client: unknown;
  /** Storage bucket 名，默认 'yue-sync' */
  bucketName?: string;
}
/**
 * 写入点 → ChangeBus 接线（openspec refactor-cloud-native-sync Phase A）
 *
 * workspace 已有事件流（workspaceService.observeEvents，携带实体对象），在此
 * 统一映射为 ChangeBus 事件；其余数据面的 emit 直接写在各存储服务写入点内
 * （task/prompt/chat/kb/workflow/graph/settings/asset/character/audio/media）。
 *
 * installSyncWritePointWiring() 幂等，由 SupabaseSyncProvider 挂载时调用一次。
 */

import { workspaceService } from '../workspace-service';
import { subscribePromptStorageChanges } from '../prompt-storage-service';
import { unifiedCacheService } from '../unified-cache-service';
import { changeBus, SWEEP_ENTITY_ID } from './change-bus';

let installed = false;

export function installSyncWritePointWiring(): void {
  if (installed) {
    return;
  }
  installed = true;

  // workspace：实体对象随事件携带，映射为键级变更
  workspaceService.observeEvents().subscribe((event: {
    type: string;
    payload?: unknown;
  }) => {
    const entity = event.payload as
      | { id?: string; updatedAt?: number }
      | undefined;
    switch (event.type) {
      case 'boardCreated':
      case 'boardUpdated':
      case 'boardDeleted':
        if (entity?.id) {
          changeBus.emit('board', entity.id, entity.updatedAt ?? Date.now());
        }
        break;
      case 'folderCreated':
      case 'folderUpdated':
      case 'folderDeleted':
        if (entity?.id) {
          changeBus.emit('folder', entity.id, entity.updatedAt ?? Date.now());
        }
        break;
      default:
        // boardSwitched / treeChanged 等非数据事件不触发同步
        break;
    }
  });

  // 提示词：服务自带微任务聚合的变更通知（增删/置顶/合并全走这里），
  // 置顶等内容变化不改 updatedAt，必须走 sweep 整体比对
  subscribePromptStorageChanges(() => {
    changeBus.emit('prompt', SWEEP_ENTITY_ID);
  });

  // 缓存媒体元数据：服务自带监听器通知（含 cacheImage/updateCacheMetadata）
  unifiedCacheService.subscribe(() => {
    changeBus.emit('cache_media', SWEEP_ENTITY_ID);
  });
}

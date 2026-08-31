/**
 * 删除本地实体（墓碑下载侧）
 *
 * 云端标记 deleted_at 的实体 → 从本地删除对应数据。
 * 安全保护（迁移自 github-sync performSafetyCheck）：
 * - 当前正在编辑的画板不删除（跳过并记录）
 * - 批量删除超过 50% 画板时跳过（避免误删）
 * - 保留其他类型（任务/聊天等删除走各自存储的删除接口）
 */

import { workspaceStorageService } from '../workspace-storage-service';
import { workspaceService } from '../workspace-service';
import { parseEntityKey, yieldToMain } from './checksum';

export interface DeleteLocalOptions {
  /** 是否允许删除当前编辑的画板（默认 false，保护当前画板） */
  allowDeleteCurrentBoard?: boolean;
}

/** 删除本地实体，返回删除数量与被保护项 */
export async function deleteLocalEntities(
  keys: string[],
  options: DeleteLocalOptions = {}
): Promise<{ deleted: number; protectedItems: string[] }> {
  if (keys.length === 0) {
    return { deleted: 0, protectedItems: [] };
  }

  let deleted = 0;
  const protectedItems: string[] = [];

  // 收集画板/文件夹删除项
  const boardKeys = keys.filter((k) => parseEntityKey(k)?.entityType === 'board');
  const otherKeys = keys.filter((k) => parseEntityKey(k)?.entityType !== 'board');

  // 画板删除安全保护
  if (boardKeys.length > 0) {
    const allBoards = await workspaceStorageService.loadAllBoards();
    const currentBoardId = workspaceService.getState().currentBoardId || null;

    // 当前画板保护
    if (currentBoardId) {
      const currentKey = boardKeys.find(
        (k) => parseEntityKey(k)?.entityId === currentBoardId
      );
      if (currentKey && !options.allowDeleteCurrentBoard) {
        protectedItems.push(currentKey);
        boardKeys.splice(boardKeys.indexOf(currentKey), 1);
      }
    }

    // 批量删除保护：>50% 画板被删则跳过全部
    if (boardKeys.length > allBoards.length / 2 && allBoards.length > 1) {
      protectedItems.push(...boardKeys);
      return { deleted, protectedItems };
    }

    for (const key of boardKeys) {
      const parsed = parseEntityKey(key);
      if (!parsed) {
        continue;
      }
      try {
        await workspaceStorageService.deleteBoard(parsed.entityId);
        deleted++;
      } catch {
        protectedItems.push(key);
      }
      await yieldToMain();
    }
  }

  // 其他类型删除
  for (const key of otherKeys) {
    const parsed = parseEntityKey(key);
    if (!parsed) {
      continue;
    }
    try {
      const ok = await deleteOne(parsed.entityType, parsed.entityId);
      if (ok) {
        deleted++;
      } else {
        protectedItems.push(key);
      }
    } catch {
      protectedItems.push(key);
    }
  }

  return { deleted, protectedItems };
}

/** 删除单个非画板实体；返回是否实际删除 */
async function deleteOne(
  entityType: string,
  entityId: string
): Promise<boolean> {
  switch (entityType) {
    case 'folder': {
      await workspaceStorageService.deleteFolder(entityId);
      return true;
    }
    case 'task': {
      const { taskStorageWriter } = await import('../media-executor/task-storage-writer');
      await taskStorageWriter.deleteTask(entityId);
      return true;
    }
    case 'workflow': {
      const { workflowStorageWriter } = await import(
        '../workflow-engine/workflow-storage-writer'
      );
      await workflowStorageWriter.deleteWorkflow?.(entityId);
      return true;
    }
    case 'chat_message': {
      const chatStorage = await import('../chat-storage-service');
      await chatStorage.deleteMessage(entityId);
      return true;
    }
    case 'chat_session': {
      const chatStorage = await import('../chat-storage-service');
      await chatStorage.deleteSession(entityId);
      return true;
    }
    case 'character': {
      const { characterStorageService } = await import(
        '../character-storage-service'
      );
      await characterStorageService.deleteCharacter(entityId);
      return true;
    }
    default:
      // 提示词/知识库/素材等以 tombstone 标记即可，本地保留（回收站语义）
      return false;
  }
}
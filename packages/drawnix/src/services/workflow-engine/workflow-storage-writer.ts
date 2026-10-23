/**
 * Workflow Storage Writer
 *
 * 主线程写入工作流数据到 aitu-app 数据库。
 * 使用主线程专用数据库，不再与 SW 共享，无 IDB 并发竞争。
 */

import type { Workflow } from './types';
import { getAppDB, APP_DB_STORES } from '../app-database';
import { changeBus } from '../supabase-sync/change-bus';
import {
  cloudDirectStore,
  isCloudOnlyStorage,
} from '../supabase-sync/cloud-direct-store';

const WORKFLOWS_STORE = APP_DB_STORES.WORKFLOWS;

/**
 * 工作流存储写入器
 */
class WorkflowStorageWriter {
  /**
   * 检查是否可用
   */
  async isAvailable(): Promise<boolean> {
    // 云端唯一存储：不依赖本地 IndexedDB
    if (isCloudOnlyStorage()) {
      return true;
    }
    try {
      const db = await getAppDB();
      return db.objectStoreNames.contains(WORKFLOWS_STORE);
    } catch {
      return false;
    }
  }

  /**
   * 获取数据库连接
   */
  private async getDB(): Promise<IDBDatabase> {
    return getAppDB();
  }

  /**
   * 保存工作流
   * 降级模式下 IndexedDB 可能不可用，失败时静默跳过，不阻塞工作流执行
   */
  async saveWorkflow(workflow: Workflow): Promise<void> {
    // 云端唯一存储（remove-local-persistence 2.3）：工作流直写云端（LWW）
    if (isCloudOnlyStorage()) {
      try {
        await cloudDirectStore.saveEntity('workflow', workflow.id, workflow, {
          cas: false,
        });
      } catch (error) {
        // 与降级模式同语义：保存失败不阻塞工作流执行（重试由存储层负责）
        console.warn('[WorkflowStorageWriter] 云端保存失败（不阻塞执行）:', error);
      }
      return;
    }
    try {
      const db = await this.getDB();
      
      // 检查 store 是否存在
      if (!db.objectStoreNames.contains(WORKFLOWS_STORE)) {
        return;
      }
      
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(WORKFLOWS_STORE, 'readwrite');
        const store = transaction.objectStore(WORKFLOWS_STORE);
        const request = store.put(workflow);

        request.onerror = () => {
          resolve(); // 不阻塞：降级模式优先保证执行
        };
        request.onsuccess = () => resolve();
      });
      // 云同步写点（refactor-cloud-native-sync）
      changeBus.emit('workflow', workflow.id, workflow.updatedAt ?? Date.now());
    } catch {
      // 静默跳过：降级模式不依赖持久化
    }
  }

  /**
   * 获取工作流
   */
  async getWorkflow(workflowId: string): Promise<Workflow | null> {
    if (!workflowId) {
      return null;
    }

    if (isCloudOnlyStorage()) {
      return cloudDirectStore.loadContent<Workflow>('workflow', workflowId);
    }

    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(WORKFLOWS_STORE, 'readonly');
      const store = transaction.objectStore(WORKFLOWS_STORE);
      const request = store.get(workflowId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  /**
   * 删除工作流
   */
  async deleteWorkflow(workflowId: string): Promise<void> {
    if (!workflowId) {
      return;
    }

    if (isCloudOnlyStorage()) {
      await cloudDirectStore.deleteEntities([`workflow:${workflowId}`]);
      return;
    }

    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(WORKFLOWS_STORE, 'readwrite');
      const store = transaction.objectStore(WORKFLOWS_STORE);
      const request = store.delete(workflowId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
    changeBus.emit('workflow', workflowId);
  }

  /**
   * 关闭数据库连接（现在由 app-database 集中管理）
   */
  close(): void {
    // no-op: 连接由 app-database 模块管理
  }
}

/**
 * 工作流存储写入器单例
 */
export const workflowStorageWriter = new WorkflowStorageWriter();

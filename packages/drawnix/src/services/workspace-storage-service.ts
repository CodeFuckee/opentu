/**
 * Workspace Storage Service
 *
 * Handles IndexedDB operations for workspace data persistence.
 * Manages folders, boards, and workspace state.
 */

import localforage from 'localforage';
import { changeBus } from './supabase-sync/change-bus';
import {
  cloudDirectStore,
  isCloudOnlyStorage,
} from './supabase-sync/cloud-direct-store';
import {
  Folder,
  Board,
  BoardMetadata,
  WorkspaceState,
  WORKSPACE_DEFAULTS,
} from '../types/workspace.types';
import { migrateElementsFillData } from '../types/fill.types';
import type { PlaitElement } from '@plait/core';

/**
 * Cache name for images (must match the one in sw/index.ts)
 */
const IMAGE_CACHE_NAME = 'drawnix-images';

/**
 * 检测 URL 是否为 Base64 data URL
 */
function isBase64ImageUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith('data:image/') && url.includes(';base64,');
}

/**
 * 将 Base64 图片缓存到 Cache API，返回虚拟路径 URL
 */
async function cacheBase64ImageToVirtualPath(dataUrl: string): Promise<string> {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return dataUrl;

  const [, mimeType, base64Data] = match;

  try {
    // 将 Base64 转为 Blob
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });

    // 生成唯一 ID
    const id = `img-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
    const ext = mimeType.split('/')[1] || 'png';
    const virtualPath = `/__aitu_cache__/image/${id}.${ext}`;

    // 缓存到 Cache API
    const cache = await caches.open(IMAGE_CACHE_NAME);
    const response = new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': blob.size.toString(),
        'Cache-Control': 'max-age=31536000',
      },
    });
    await cache.put(virtualPath, response);

    return virtualPath;
  } catch (error) {
    console.error('[Migration] Failed to cache Base64 image:', error);
    return dataUrl;
  }
}

/**
 * 迁移画布元素中的 Base64 图片 URL 到虚拟路径
 * 返回是否有元素被迁移
 */
async function migrateElementsBase64Urls(elements: PlaitElement[]): Promise<boolean> {
  let migrated = false;

  for (const element of elements) {
    // 检查图片元素
    if ((element as any).url && isBase64ImageUrl((element as any).url)) {
      const originalSize = Math.round((element as any).url.length / 1024);
      const newUrl = await cacheBase64ImageToVirtualPath((element as any).url);
      if (newUrl !== (element as any).url) {
        (element as any).url = newUrl;
        migrated = true;
        // console.log(`[Migration] Element ${element.id}: Base64 (${originalSize}KB) -> ${newUrl}`);
      }
    }

    // 递归处理子元素
    if ((element as any).children && Array.isArray((element as any).children)) {
      const childMigrated = await migrateElementsBase64Urls((element as any).children);
      if (childMigrated) migrated = true;
    }
  }

  return migrated;
}

/**
 * Database configuration
 */
const WORKSPACE_DB_CONFIG = {
  DATABASE_NAME: 'aitu-workspace',
  MIN_DATABASE_VERSION: 8,
  STORES: {
    FOLDERS: 'folders',
    BOARDS: 'boards',
    STATE: 'state',
  },
} as const;

const STATE_KEY = 'workspace_state';

/**
 * Helper to wait for browser idle time
 */
function waitForIdle(timeout = 50): Promise<void> {
  return new Promise(resolve => {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (window as Window).requestIdleCallback(() => resolve(), { timeout });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Detect existing database version to avoid downgrade errors
 */
async function detectDatabaseVersion(dbName: string): Promise<number> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      console.warn('[WorkspaceStorage] IndexedDB not available, using min version');
      resolve(WORKSPACE_DB_CONFIG.MIN_DATABASE_VERSION);
      return;
    }
    
    // Open without version to get current version
    const request = indexedDB.open(dbName);
    
    request.onsuccess = () => {
      const db = request.result;
      const version = db.version;
      db.close();
      const targetVersion = Math.max(version, WORKSPACE_DB_CONFIG.MIN_DATABASE_VERSION);
      resolve(targetVersion);
    };
    
    request.onerror = (event) => {
      // Try to get version from error event or use a safe high version
      console.error('[WorkspaceStorage] Error detecting DB version:', event);
      // Use a higher version to avoid downgrade - version 10 should be safe
      resolve(10);
    };
    
    request.onblocked = () => {
      // Database is blocked by another connection, use a safe high version
      console.warn('[WorkspaceStorage] DB blocked, using safe version 10');
      resolve(10);
    };
  });
}

/**
 * Workspace storage service for managing data persistence
 */
class WorkspaceStorageService {
  private foldersStore: LocalForage | null = null;
  private boardsStore: LocalForage | null = null;
  private stateStore: LocalForage | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    // Defer store creation until initialization to detect version first
  }

  /**
   * Create stores with the detected version
   */
  private async createStores(): Promise<void> {
    const version = await detectDatabaseVersion(WORKSPACE_DB_CONFIG.DATABASE_NAME);
    
    this.foldersStore = localforage.createInstance({
      driver: localforage.INDEXEDDB,
      name: WORKSPACE_DB_CONFIG.DATABASE_NAME,
      version: version,
      storeName: WORKSPACE_DB_CONFIG.STORES.FOLDERS,
      description: 'Workspace folders storage',
    });

    this.boardsStore = localforage.createInstance({
      driver: localforage.INDEXEDDB,
      name: WORKSPACE_DB_CONFIG.DATABASE_NAME,
      version: version,
      storeName: WORKSPACE_DB_CONFIG.STORES.BOARDS,
      description: 'Workspace boards storage',
    });

    this.stateStore = localforage.createInstance({
      driver: localforage.INDEXEDDB,
      name: WORKSPACE_DB_CONFIG.DATABASE_NAME,
      version: version,
      storeName: WORKSPACE_DB_CONFIG.STORES.STATE,
      description: 'Workspace state storage',
    });
  }

  /**
   * Initialize storage service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // 云端唯一存储模式（remove-local-persistence）：本地 IndexedDB 不参与持久化，
    // 跳过 localforage 初始化；数据读写全部走 cloudDirectStore
    if (isCloudOnlyStorage()) {
      this.initialized = true;
      return;
    }

    // Ensure we only initialize once even if called concurrently
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      // Create stores with detected version first
      await this.createStores();
      
      await Promise.all([
        this.foldersStore!.ready(),
        this.boardsStore!.ready(),
        this.stateStore!.ready(),
      ]);
      this.initialized = true;
    } catch (error) {
      console.error('[WorkspaceStorage] Failed to initialize:', error);
      
      // Check if it's a version downgrade error
      const errorMsg = String(error);
      if (errorMsg.includes("can't be downgraded") || errorMsg.includes('version')) {
        console.warn('[WorkspaceStorage] Version conflict detected, attempting recovery...');
        
        // Try to delete the database and reinitialize
        try {
          await this.deleteDatabase();
          await this.createStores();
          await Promise.all([
            this.foldersStore!.ready(),
            this.boardsStore!.ready(),
            this.stateStore!.ready(),
          ]);
          this.initialized = true;
          return;
        } catch (recoveryError) {
          console.error('[WorkspaceStorage] Recovery failed:', recoveryError);
        }
      }
      
      throw new Error('Workspace storage initialization failed');
    }
  }

  /**
   * Delete the database (for recovery from version conflicts)
   */
  private async deleteDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        resolve();
        return;
      }
      
      const request = indexedDB.deleteDatabase(WORKSPACE_DB_CONFIG.DATABASE_NAME);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        console.error('[WorkspaceStorage] Failed to delete database');
        reject(new Error('Failed to delete database'));
      };
      request.onblocked = () => {
        console.warn('[WorkspaceStorage] Database deletion blocked');
        // Still resolve after a timeout
        setTimeout(resolve, 1000);
      };
    });
  }

  // ========== Private Store Getters (ensure initialized) ==========

  private getFoldersStore(): LocalForage {
    if (!this.foldersStore) {
      throw new Error('WorkspaceStorage not initialized');
    }
    return this.foldersStore;
  }

  private getBoardsStore(): LocalForage {
    if (!this.boardsStore) {
      throw new Error('WorkspaceStorage not initialized');
    }
    return this.boardsStore;
  }

  private getStateStore(): LocalForage {
    if (!this.stateStore) {
      throw new Error('WorkspaceStorage not initialized');
    }
    return this.stateStore;
  }

  // ========== Folder Operations ==========

  async saveFolder(folder: Folder): Promise<void> {
    if (isCloudOnlyStorage()) {
      await cloudDirectStore.saveEntity('folder', folder.id, folder, {
        cas: false,
      });
      return;
    }
    await this.ensureInitialized();
    await this.getFoldersStore().setItem(folder.id, folder);
  }

  async loadFolder(id: string): Promise<Folder | null> {
    if (isCloudOnlyStorage()) {
      return cloudDirectStore.loadContent<Folder>('folder', id);
    }
    await this.ensureInitialized();
    return this.getFoldersStore().getItem<Folder>(id);
  }

  async loadAllFolders(): Promise<Folder[]> {
    if (isCloudOnlyStorage()) {
      const entities = await cloudDirectStore.loadEntitiesByTypes(['folder']);
      const folders = entities
        .map((entity) => entity.content as Folder)
        .filter((folder) => folder && folder.id);
      return folders.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    await this.ensureInitialized();
    const folders: Folder[] = [];
    await this.getFoldersStore().iterate<Folder, void>((value) => {
      if (value && value.id) folders.push(value);
    });
    // Wait for browser idle time after IndexedDB operation
    await waitForIdle();
    return folders.sort((a, b) => a.order - b.order);
  }

  async deleteFolder(id: string): Promise<void> {
    if (isCloudOnlyStorage()) {
      await cloudDirectStore.deleteEntities([`folder:${id}`]);
      return;
    }
    await this.ensureInitialized();
    await this.getFoldersStore().removeItem(id);
  }

  // ========== Board Operations ==========

  async saveBoard(board: Board): Promise<void> {
    if (isCloudOnlyStorage()) {
      // 画板写走 CAS 乐观锁（remove-local-persistence D2）：基线来自本端最近一次
      // 云端读取/写入的行时间戳；他端抢先写入时抛 CloudWriteConflictError 拒绝覆盖
      await cloudDirectStore.saveEntity('board', board.id, board, { cas: true });
      return;
    }
    await this.ensureInitialized();
    await this.getBoardsStore().setItem(board.id, board);
  }

  /**
   * 画板加载后的元素迁移（fill 数据格式 + Base64 图片落 Cache API）。
   * 两条存储路径共用；迁移写回复用 saveBoard（云端路径即 CAS 写）。
   */
  private async migrateLoadedBoard(board: Board): Promise<Board> {
    if (board && board.elements) {
      // 迁移 fill 数据格式，确保渐变填充不会显示为黑色
      board.elements = migrateElementsFillData(board.elements);

      // 迁移 Base64 图片 URL 到虚拟路径（同步等待，确保画布显示迁移后的数据）
      try {
        const migrated = await migrateElementsBase64Urls(board.elements);
        if (migrated) {
          await this.saveBoard(board);
        }
      } catch (error) {
        console.error(`[Migration] Board ${board.id}: Failed to migrate`, error);
      }
    }
    return board;
  }

  async loadBoard(id: string): Promise<Board | null> {
    if (isCloudOnlyStorage()) {
      const board = await cloudDirectStore.loadContent<Board>('board', id);
      if (!board) {
        return null;
      }
      return this.migrateLoadedBoard(board);
    }
    await this.ensureInitialized();
    let board: Board | null;
    try {
      board = await this.getBoardsStore().getItem<Board>(id);
    } catch (error) {
      console.error(`[Storage] Failed to load board ${id} from IndexedDB:`, error);
      return null;
    }
    if (board && board.elements) {
      await this.migrateLoadedBoard(board);
    }
    return board;
  }

  async loadAllBoards(): Promise<Board[]> {
    if (isCloudOnlyStorage()) {
      const entities = await cloudDirectStore.loadEntitiesByTypes(['board']);
      const boards: Board[] = [];
      for (const entity of entities) {
        const board = entity.content as Board;
        if (!board || !board.id) {
          continue;
        }
        if (board.elements) {
          board.elements = migrateElementsFillData(board.elements);
        }
        boards.push(board);
      }
      return boards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    await this.ensureInitialized();
    const boards: Board[] = [];
    await this.getBoardsStore().iterate<Board, void>((value) => {
      if (value && value.id) {
        // 迁移 fill 数据格式，确保渐变填充不会显示为黑色
        if (value.elements) {
          value.elements = migrateElementsFillData(value.elements);
        }
        boards.push(value);
      }
    });
    // Wait for browser idle time after IndexedDB operation
    await waitForIdle();

    // 迁移 Base64 图片 URL 到虚拟路径
    for (const board of boards) {
      if (board.elements) {
        try {
          const migrated = await migrateElementsBase64Urls(board.elements);
          if (migrated) {
            await this.saveBoard(board);
            // console.log(`[Migration] Board ${board.id}: Base64 URLs migrated and saved`);
          }
        } catch (error) {
          console.error(`[Migration] Board ${board.id}: Failed to migrate`, error);
        }
      }
    }

    return boards.sort((a, b) => a.order - b.order);
  }

  /**
   * 加载所有画板的元数据（不含 elements）
   * 用于侧边栏显示，减少内存占用
   */
  async loadAllBoardMetadata(): Promise<BoardMetadata[]> {
    if (isCloudOnlyStorage()) {
      // 云端投影拉取：不传 elements 大字段（remove-local-persistence D5）
      const rows = await cloudDirectStore.loadBoardMetadata();
      const boards: BoardMetadata[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        folderId: row.folderId,
        order: row.order,
        viewport: row.viewport as BoardMetadata['viewport'],
        theme: row.theme as BoardMetadata['theme'],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
      return boards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    await this.ensureInitialized();
    const boards: BoardMetadata[] = [];
    await this.getBoardsStore().iterate<Board, void>((value) => {
      if (value && value.id) {
        // 只提取元数据，不包含 elements
        boards.push({
          id: value.id,
          name: value.name,
          folderId: value.folderId,
          order: value.order,
          viewport: value.viewport,
          theme: value.theme,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
        });
      }
    });
    // Wait for browser idle time after IndexedDB operation
    await waitForIdle();

    return boards.sort((a, b) => a.order - b.order);
  }

  async loadFolderBoards(folderId: string | null): Promise<Board[]> {
    if (isCloudOnlyStorage()) {
      const metas = await cloudDirectStore.loadBoardMetadata();
      const ids = metas
        .filter((meta) => (meta.folderId ?? null) === folderId)
        .map((meta) => meta.id);
      const boards: Board[] = [];
      for (const id of ids) {
        const board = await cloudDirectStore.loadContent<Board>('board', id);
        if (board) {
          boards.push(board);
        }
      }
      return boards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    await this.ensureInitialized();
    const boards: Board[] = [];
    await this.getBoardsStore().iterate<Board, void>((value) => {
      if (value && value.folderId === folderId) {
        // 迁移 fill 数据格式，确保渐变填充不会显示为黑色
        if (value.elements) {
          value.elements = migrateElementsFillData(value.elements);
        }
        boards.push(value);
      }
    });
    // Wait for browser idle time after IndexedDB operation
    await waitForIdle();
    return boards.sort((a, b) => a.order - b.order);
  }

  async deleteBoard(id: string): Promise<void> {
    if (isCloudOnlyStorage()) {
      // 云端唯一存储：真删除（无墓碑，remove-local-persistence D6）
      await cloudDirectStore.deleteEntities([`board:${id}`]);
      return;
    }
    await this.ensureInitialized();
    await this.getBoardsStore().removeItem(id);
  }

  async deleteFolderBoards(folderId: string): Promise<void> {
    if (isCloudOnlyStorage()) {
      const metas = await cloudDirectStore.loadBoardMetadata();
      const keys = metas
        .filter((meta) => meta.folderId === folderId)
        .map((meta) => `board:${meta.id}`);
      await cloudDirectStore.deleteEntities(keys);
      return;
    }
    await this.ensureInitialized();
    const boards = await this.loadFolderBoards(folderId);
    await Promise.all(boards.map((b) => this.deleteBoard(b.id)));
  }

  // ========== State Operations ==========

  async saveState(state: WorkspaceState): Promise<void> {
    if (isCloudOnlyStorage()) {
      await cloudDirectStore.saveEntity('workspace_state', 'default', state, {
        cas: false,
      });
      return;
    }
    // 云同步写点（refactor-cloud-native-sync）：当前画板/折叠状态等变化触发上云
    changeBus.emit('workspace_state', 'default', Date.now());
    await this.ensureInitialized();
    await this.getStateStore().setItem(STATE_KEY, state);
  }

  async loadState(): Promise<WorkspaceState> {
    if (isCloudOnlyStorage()) {
      const state = await cloudDirectStore.loadContent<WorkspaceState>(
        'workspace_state',
        'default'
      );
      return (
        state || {
          currentBoardId: null,
          expandedFolderIds: [],
          sidebarWidth: WORKSPACE_DEFAULTS.SIDEBAR_WIDTH,
          sidebarCollapsed: false,
        }
      );
    }
    await this.ensureInitialized();
    const state = await this.getStateStore().getItem<WorkspaceState>(STATE_KEY);
    return (
      state || {
        currentBoardId: null,
        expandedFolderIds: [],
        sidebarWidth: WORKSPACE_DEFAULTS.SIDEBAR_WIDTH,
        sidebarCollapsed: false,
      }
    );
  }

  // ========== Utility Operations ==========

  async getBoardCount(): Promise<number> {
    if (isCloudOnlyStorage()) {
      return (await cloudDirectStore.loadBoardMetadata()).length;
    }
    await this.ensureInitialized();
    return this.getBoardsStore().length();
  }

  async clearAll(): Promise<void> {
    if (isCloudOnlyStorage()) {
      const entities = await cloudDirectStore.loadEntitiesByTypes([
        'board',
        'folder',
      ]);
      const keys = entities.map(
        (entity) => `${entity.entity_type}:${entity.entity_id}`
      );
      keys.push('workspace_state:default');
      await cloudDirectStore.deleteEntities(keys);
      return;
    }
    await this.ensureInitialized();
    await Promise.all([
      this.getFoldersStore().clear(),
      this.getBoardsStore().clear(),
      this.getStateStore().clear(),
    ]);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

export const workspaceStorageService = new WorkspaceStorageService();

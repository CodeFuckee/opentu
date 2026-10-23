import localforage from 'localforage';
import { generateUUID } from '../utils/runtime-helpers';
import { changeBus, SWEEP_ENTITY_ID } from './supabase-sync/change-bus';
import {
  cloudDirectStore,
  isCloudOnlyStorage,
} from './supabase-sync/cloud-direct-store';
import {
  AUDIO_PLAYLIST_FAVORITES_ID,
  createAudioPlaylistItem,
  getAudioPlaylistItemRef,
  isAudioPlaylistAssetItemRef,
  isSameAudioPlaylistItemRef,
  type AudioPlaylist,
  type AudioPlaylistItem,
  type AudioPlaylistItemRef,
} from '../types/audio-playlist.types';

const PLAYLIST_META_STORE = 'audio_playlists';
const PLAYLIST_ITEMS_STORE = 'audio_playlist_items';

class AudioPlaylistService {
  private playlistStore: LocalForage | null = null;
  private playlistItemsStore: LocalForage | null = null;

  async initialize(): Promise<void> {
    if (!this.playlistStore) {
      this.playlistStore = localforage.createInstance({
        name: 'aitu-audio-playlists',
        storeName: PLAYLIST_META_STORE,
      });
    }

    if (!this.playlistItemsStore) {
      this.playlistItemsStore = localforage.createInstance({
        name: 'aitu-audio-playlists',
        storeName: PLAYLIST_ITEMS_STORE,
      });
    }

    await this.ensureFavoritesPlaylist();
  }

  private ensureInitialized(): void {
    if (!this.playlistStore || !this.playlistItemsStore) {
      throw new Error('AudioPlaylistService not initialized');
    }
  }

  // ==== 云端唯一存储（remove-local-persistence 2.4）存储原语分流 ====
  // 云端实体布局与 local-collector/apply-remote 约定一致：
  // <id> = 播放列表元数据；<id>:items = { playlistId, items }

  private async getPlaylistMeta(id: string): Promise<AudioPlaylist | null> {
    if (isCloudOnlyStorage()) {
      return cloudDirectStore.loadContent<AudioPlaylist>('audio_playlist', id);
    }
    this.ensureInitialized();
    return this.playlistStore!.getItem<AudioPlaylist>(id);
  }

  private async setPlaylistMeta(id: string, meta: AudioPlaylist): Promise<void> {
    if (isCloudOnlyStorage()) {
      await cloudDirectStore.saveEntity('audio_playlist', id, meta, {
        cas: false,
      });
      return;
    }
    this.ensureInitialized();
    await this.playlistStore!.setItem(id, meta);
  }

  private async removePlaylistMeta(id: string): Promise<void> {
    if (isCloudOnlyStorage()) {
      await cloudDirectStore.deleteEntities([`audio_playlist:${id}`]);
      return;
    }
    this.ensureInitialized();
    await this.playlistStore!.removeItem(id);
  }

  private async listPlaylistMetas(): Promise<AudioPlaylist[]> {
    if (isCloudOnlyStorage()) {
      return cloudDirectStore.listContents<AudioPlaylist>('audio_playlist');
    }
    this.ensureInitialized();
    const keys = await this.playlistStore!.keys();
    const playlists = await Promise.all(
      keys.map((key) => this.playlistStore!.getItem<AudioPlaylist>(key))
    );
    return playlists.filter(
      (playlist): playlist is AudioPlaylist => !!playlist
    );
  }

  private async getItems(id: string): Promise<AudioPlaylistItem[]> {
    if (isCloudOnlyStorage()) {
      const wrapper = await cloudDirectStore.loadContent<{
        playlistId: string;
        items: AudioPlaylistItem[];
      }>('audio_playlist', `${id}:items`);
      return wrapper?.items ?? [];
    }
    this.ensureInitialized();
    return (
      (await this.playlistItemsStore!.getItem<AudioPlaylistItem[]>(id)) || []
    );
  }

  private async setItems(id: string, items: AudioPlaylistItem[]): Promise<void> {
    if (isCloudOnlyStorage()) {
      await cloudDirectStore.saveEntity(
        'audio_playlist',
        `${id}:items`,
        { playlistId: id, items },
        { cas: false }
      );
      return;
    }
    this.ensureInitialized();
    await this.playlistItemsStore!.setItem(id, items);
  }

  private async removeItems(id: string): Promise<void> {
    if (isCloudOnlyStorage()) {
      await cloudDirectStore.deleteEntities([`audio_playlist:${id}:items`]);
      return;
    }
    this.ensureInitialized();
    await this.playlistItemsStore!.removeItem(id);
  }

  private getNow(): number {
    return Date.now();
  }

  private async ensureFavoritesPlaylist(): Promise<void> {
    this.ensureInitialized();
    const existing = await this.getPlaylistMeta(AUDIO_PLAYLIST_FAVORITES_ID);
    if (existing) {
      return;
    }

    const now = this.getNow();
    const playlist: AudioPlaylist = {
      id: AUDIO_PLAYLIST_FAVORITES_ID,
      name: '收藏',
      createdAt: now,
      updatedAt: now,
      isSystem: true,
    };
    await this.setPlaylistMeta(playlist.id, playlist);
    await this.setItems(playlist.id, []);
  }

  async listPlaylists(): Promise<AudioPlaylist[]> {
    if (isCloudOnlyStorage()) {
      const playlists = await this.listPlaylistMetas();
      return playlists
        .filter((playlist) => !!playlist)
        .sort((left, right) => {
          if (left.id === AUDIO_PLAYLIST_FAVORITES_ID) return -1;
          if (right.id === AUDIO_PLAYLIST_FAVORITES_ID) return 1;
          return right.updatedAt - left.updatedAt;
        });
    }
    this.ensureInitialized();
    const playlists = await this.listPlaylistMetas();
    return playlists
      .filter((playlist): playlist is AudioPlaylist => !!playlist)
      .sort((left, right) => {
        if (left.id === AUDIO_PLAYLIST_FAVORITES_ID) return -1;
        if (right.id === AUDIO_PLAYLIST_FAVORITES_ID) return 1;
        return right.updatedAt - left.updatedAt;
      });
  }

  async getPlaylistItems(playlistId: string): Promise<AudioPlaylistItem[]> {
    return this.getItems(playlistId);
  }

  async listPlaylistItems(): Promise<Record<string, AudioPlaylistItem[]>> {
    const playlists = await this.listPlaylists();
    const pairs = await Promise.all(
      playlists.map(
        async (playlist) =>
          [playlist.id, await this.getPlaylistItems(playlist.id)] as const
      )
    );
    return Object.fromEntries(pairs);
  }

  /** 云同步写点（refactor-cloud-native-sync）：列表与条目一起 sweep */
  private emitSyncChange(): void {
    changeBus.emit('audio_playlist', SWEEP_ENTITY_ID, Date.now());
  }

  async createPlaylist(name: string): Promise<AudioPlaylist> {
    this.ensureInitialized();
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('播放列表名称不能为空');
    }
    const existing = await this.listPlaylists();
    if (existing.some((playlist) => playlist.name === trimmedName)) {
      throw new Error('播放列表名称已存在');
    }
    const now = this.getNow();
    const playlist: AudioPlaylist = {
      id: generateUUID(),
      name: trimmedName,
      createdAt: now,
      updatedAt: now,
    };
    await this.setItems(playlist.id, []);
    await this.setPlaylistMeta(playlist.id, playlist);
    this.emitSyncChange();
    return playlist;
  }

  async renamePlaylist(playlistId: string, name: string): Promise<void> {
    this.ensureInitialized();
    const playlist = await this.getPlaylistMeta(playlistId);
    if (!playlist) {
      throw new Error('播放列表不存在');
    }
    if (playlist.isSystem) {
      throw new Error('系统播放列表不支持重命名');
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('播放列表名称不能为空');
    }
    const existing = await this.listPlaylists();
    if (
      existing.some(
        (item) => item.id !== playlistId && item.name === trimmedName
      )
    ) {
      throw new Error('播放列表名称已存在');
    }
    await this.setPlaylistMeta(playlistId, {
      ...playlist,
      name: trimmedName,
      updatedAt: this.getNow(),
    });
    this.emitSyncChange();
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    this.ensureInitialized();
    const playlist = await this.getPlaylistMeta(playlistId);
    if (!playlist) {
      return;
    }
    if (playlist.isSystem) {
      throw new Error('系统播放列表不可删除');
    }
    await this.removePlaylistMeta(playlistId);
    await this.removeItems(playlistId);
    this.emitSyncChange();
  }

  async addItemToPlaylist(
    itemRef: AudioPlaylistItemRef,
    playlistId: string
  ): Promise<void> {
    this.ensureInitialized();
    const playlist = await this.getPlaylistMeta(playlistId);
    if (!playlist) {
      throw new Error('播放列表不存在');
    }
    if (playlistId === AUDIO_PLAYLIST_FAVORITES_ID && !isAudioPlaylistAssetItemRef(itemRef)) {
      throw new Error('收藏仅支持音频素材');
    }

    const items = await this.getPlaylistItems(playlistId);
    if (
      items.some((item) => {
        const existingRef = getAudioPlaylistItemRef(item);
        return existingRef ? isSameAudioPlaylistItemRef(existingRef, itemRef) : false;
      })
    ) {
      return;
    }

    const nextItems: AudioPlaylistItem[] = [
      createAudioPlaylistItem(playlistId, itemRef, this.getNow()),
      ...items,
    ];
    await this.setItems(playlistId, nextItems);
    await this.setPlaylistMeta(playlistId, {
      ...playlist,
      updatedAt: this.getNow(),
    });
    this.emitSyncChange();
  }

  async addAssetToPlaylist(assetId: string, playlistId: string): Promise<void> {
    await this.addItemToPlaylist({ kind: 'asset', assetId }, playlistId);
  }

  async removeItemFromPlaylist(
    itemRef: AudioPlaylistItemRef,
    playlistId: string
  ): Promise<void> {
    this.ensureInitialized();
    const playlist = await this.getPlaylistMeta(playlistId);
    if (!playlist) {
      return;
    }
    const items = await this.getPlaylistItems(playlistId);
    const nextItems = items.filter((item) => {
      const existingRef = getAudioPlaylistItemRef(item);
      return existingRef ? !isSameAudioPlaylistItemRef(existingRef, itemRef) : true;
    });
    await this.setItems(playlistId, nextItems);
    await this.setPlaylistMeta(playlistId, {
      ...playlist,
      updatedAt: this.getNow(),
    });
    this.emitSyncChange();
  }

  async removeAssetFromPlaylist(
    assetId: string,
    playlistId: string
  ): Promise<void> {
    await this.removeItemFromPlaylist({ kind: 'asset', assetId }, playlistId);
  }

  async removeAssetFromAllPlaylists(assetId: string): Promise<void> {
    const playlists = await this.listPlaylists();
    await Promise.all(
      playlists.map((playlist) =>
        this.removeAssetFromPlaylist(assetId, playlist.id)
      )
    );
  }

  async toggleFavorite(assetId: string): Promise<boolean> {
    const items = await this.getPlaylistItems(AUDIO_PLAYLIST_FAVORITES_ID);
    const exists = items.some((item) => {
      const ref = getAudioPlaylistItemRef(item);
      return ref ? isSameAudioPlaylistItemRef(ref, { kind: 'asset', assetId }) : false;
    });
    if (exists) {
      await this.removeItemFromPlaylist(
        { kind: 'asset', assetId },
        AUDIO_PLAYLIST_FAVORITES_ID
      );
      return false;
    }
    await this.addItemToPlaylist(
      { kind: 'asset', assetId },
      AUDIO_PLAYLIST_FAVORITES_ID
    );
    return true;
  }
}

export const audioPlaylistService = new AudioPlaylistService();

/**
 * Chat Storage Service
 *
 * Handles persistence of chat sessions and messages using IndexedDB via localforage.
 */

import localforage from 'localforage';
import { generateUUID } from '../utils/runtime-helpers';
import { CHAT_STORAGE_KEYS, CHAT_CONSTANTS } from '../constants/CHAT_CONSTANTS';
import type { ChatSession, ChatMessage, DrawerState } from '../types/chat.types';
import { changeBus } from './supabase-sync/change-bus';
import {
  cloudDirectStore,
  isCloudOnlyStorage,
} from './supabase-sync/cloud-direct-store';

// Initialize localforage instances
const sessionsStore = localforage.createInstance({
  name: CHAT_STORAGE_KEYS.DATABASE_NAME,
  storeName: CHAT_STORAGE_KEYS.SESSIONS_STORE,
});

const messagesStore = localforage.createInstance({
  name: CHAT_STORAGE_KEYS.DATABASE_NAME,
  storeName: CHAT_STORAGE_KEYS.MESSAGES_STORE,
});

/** Generate UUID v4 */
function generateId(): string {
  return generateUUID();
}

/** Generate session title from first message */
function generateTitle(content: string): string {
  const cleaned = content.trim().replace(/\n/g, ' ');
  if (cleaned.length <= CHAT_CONSTANTS.MAX_TITLE_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, CHAT_CONSTANTS.MAX_TITLE_LENGTH - 3) + '...';
}

// ============================================================================
// Session Operations
// ============================================================================

export async function createSession(): Promise<ChatSession> {
  const now = Date.now();
  const session: ChatSession = {
    id: generateId(),
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };

  // 云端唯一存储：会话直写云端
  if (isCloudOnlyStorage()) {
    await cloudDirectStore.saveEntity('chat_session', session.id, session, {
      cas: false,
    });
    return session;
  }

  await sessionsStore.setItem(session.id, session);
  changeBus.emit('chat_session', session.id, session.updatedAt);
  return session;
}

export async function getSession(id: string): Promise<ChatSession | null> {
  // 云端唯一存储（remove-local-persistence 2.4）：会话/消息直连云端
  if (isCloudOnlyStorage()) {
    return cloudDirectStore.loadContent<ChatSession>('chat_session', id);
  }
  return sessionsStore.getItem<ChatSession>(id);
}

export async function getAllSessions(): Promise<ChatSession[]> {
  // 云端唯一存储：类型级拉取，updatedAt 倒序
  if (isCloudOnlyStorage()) {
    const sessions = await cloudDirectStore.listContents<ChatSession>(
      'chat_session'
    );
    return sessions
      .filter((session) => session && session.id)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const sessions: ChatSession[] = [];
  await sessionsStore.iterate<ChatSession, void>((value) => {
    sessions.push(value);
  });
  // Wait for browser idle time before sorting to avoid blocking
  await new Promise<void>(resolve => {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (window as Window).requestIdleCallback(() => resolve(), { timeout: 50 });
    } else {
      setTimeout(resolve, 0);
    }
  });
  // Sort by updatedAt descending (newest first)
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateSession(
  id: string,
  updates: Partial<ChatSession>
): Promise<void> {
  const session = await getSession(id);
  if (session) {
    const updated = { ...session, ...updates, updatedAt: Date.now() };
    if (isCloudOnlyStorage()) {
      await cloudDirectStore.saveEntity('chat_session', id, updated, {
        cas: false,
      });
      return;
    }
    await sessionsStore.setItem(id, updated);
    changeBus.emit('chat_session', id, updated.updatedAt);
  }
}

export async function deleteSession(id: string): Promise<void> {
  // 云端唯一存储：会话＋其消息真删除
  if (isCloudOnlyStorage()) {
    const messages = await getMessages(id);
    const keys = messages.map((message) => `chat_message:${message.id}`);
    keys.push(`chat_session:${id}`);
    await cloudDirectStore.deleteEntities(keys);
    return;
  }
  // Delete all messages in the session first
  const messages = await getMessages(id);
  for (const message of messages) {
    await messagesStore.removeItem(message.id);
  }
  // Then delete the session
  await sessionsStore.removeItem(id);
  for (const message of messages) {
    changeBus.emit('chat_message', message.id);
  }
  changeBus.emit('chat_session', id);
}

// ============================================================================
// Message Operations
// ============================================================================

export async function addMessage(message: ChatMessage): Promise<void> {
  // 云端唯一存储：消息直写云端（apply-remote 同款语义：本地无则建/已有则覆盖）
  if (isCloudOnlyStorage()) {
    await cloudDirectStore.saveEntity('chat_message', message.id, message, {
      cas: false,
    });
    const session = await getSession(message.sessionId);
    if (session) {
      await updateSession(message.sessionId, {
        messageCount: session.messageCount + 1,
        updatedAt: Date.now(),
      });
    }
    return;
  }

  await messagesStore.setItem(message.id, message);
  changeBus.emit('chat_message', message.id, message.timestamp ?? Date.now());

  // Update session message count and title if this is the first user message
  const session = await getSession(message.sessionId);
  if (session) {
    const updates: Partial<ChatSession> = {
      messageCount: session.messageCount + 1,
      updatedAt: Date.now(),
    };

    await updateSession(message.sessionId, updates);
  }
}

export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  // 云端唯一存储：类型级拉取后按会话过滤，timestamp 升序
  if (isCloudOnlyStorage()) {
    const messages = await cloudDirectStore.listContents<ChatMessage>(
      'chat_message'
    );
    return messages
      .filter((message) => message && message.sessionId === sessionId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }
  const messages: ChatMessage[] = [];
  await messagesStore.iterate<ChatMessage, void>((value) => {
    if (value.sessionId === sessionId) {
      messages.push(value);
    }
  });
  // Sort by timestamp ascending (oldest first)
  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

export async function updateMessage(
  id: string,
  updates: Partial<ChatMessage>
): Promise<void> {
  const message = await messagesStore.getItem<ChatMessage>(id);
  if (message) {
    const updated = { ...message, ...updates };
    if (isCloudOnlyStorage()) {
      await cloudDirectStore.saveEntity('chat_message', id, updated, {
        cas: false,
      });
      return;
    }
    await messagesStore.setItem(id, updated);
    changeBus.emit('chat_message', id, updated.timestamp ?? Date.now());
  }
}

export async function deleteMessage(id: string): Promise<void> {
  const message = await (isCloudOnlyStorage()
    ? cloudDirectStore.loadContent<ChatMessage>('chat_message', id)
    : messagesStore.getItem<ChatMessage>(id));
  if (message) {
    if (isCloudOnlyStorage()) {
      await cloudDirectStore.deleteEntities([`chat_message:${id}`]);
      const session = await getSession(message.sessionId);
      if (session) {
        await updateSession(message.sessionId, {
          messageCount: Math.max(0, session.messageCount - 1),
        });
      }
      return;
    }
    await messagesStore.removeItem(id);
    changeBus.emit('chat_message', id);
    // Update session message count
    const session = await getSession(message.sessionId);
    if (session) {
      await updateSession(message.sessionId, {
        messageCount: Math.max(0, session.messageCount - 1),
      });
    }
  }
}

// ============================================================================
// Drawer State Operations (localStorage for sync access)
// ============================================================================

const DEFAULT_DRAWER_STATE: DrawerState = {
  isOpen: false,
  width: Math.min(
    CHAT_CONSTANTS.DRAWER_MAX_WIDTH,
    Math.max(
      CHAT_CONSTANTS.DRAWER_MIN_WIDTH,
      window.innerWidth * CHAT_CONSTANTS.DRAWER_DEFAULT_WIDTH_RATIO
    )
  ),
  activeSessionId: null,
};

export function getDrawerState(): DrawerState {
  try {
    const stored = localStorage.getItem(CHAT_STORAGE_KEYS.DRAWER_STATE);
    if (stored) {
      return { ...DEFAULT_DRAWER_STATE, ...JSON.parse(stored) };
    }
  } catch (error) {
    console.error('[ChatStorage] Failed to get drawer state:', error);
  }
  return DEFAULT_DRAWER_STATE;
}

export function setDrawerState(state: Partial<DrawerState>): void {
  try {
    const current = getDrawerState();
    const updated = { ...current, ...state };
    localStorage.setItem(CHAT_STORAGE_KEYS.DRAWER_STATE, JSON.stringify(updated));
  } catch (error) {
    console.error('[ChatStorage] Failed to set drawer state:', error);
  }
}

// ============================================================================
// Cleanup Operations
// ============================================================================

export async function clearAllData(): Promise<void> {
  // 云端唯一存储：清空云端会话与消息（抽屉状态是 localStorage 瞬态，保留）
  if (isCloudOnlyStorage()) {
    const [sessions, messages] = await Promise.all([
      cloudDirectStore.listContents<ChatSession>('chat_session'),
      cloudDirectStore.listContents<ChatMessage>('chat_message'),
    ]);
    const keys = [
      ...sessions.filter((s) => s?.id).map((s) => `chat_session:${s.id}`),
      ...messages.filter((m) => m?.id).map((m) => `chat_message:${m.id}`),
    ];
    if (keys.length > 0) {
      await cloudDirectStore.deleteEntities(keys);
    }
    localStorage.removeItem(CHAT_STORAGE_KEYS.DRAWER_STATE);
    return;
  }
  await sessionsStore.clear();
  await messagesStore.clear();
  localStorage.removeItem(CHAT_STORAGE_KEYS.DRAWER_STATE);
}

// ============================================================================
// Utility Functions
// ============================================================================

export { generateId, generateTitle };

// Export as service object for easier mocking
export const chatStorageService = {
  createSession,
  getSession,
  getAllSessions,
  updateSession,
  deleteSession,
  addMessage,
  getMessages,
  updateMessage,
  deleteMessage,
  getDrawerState,
  setDrawerState,
  clearAllData,
  generateId,
  generateTitle,
};

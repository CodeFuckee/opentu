/**
 * 本地数据收集器纯函数测试（测试先行）
 *
 * 收集器把各数据源（workspace/boards/tasks/workflows/prompts/kb/chat/audio/characters/assets/settings/custom-tools）
 * 归一化为 SyncEntity[]。核心纯函数是 `toSyncEntities` —— 输入原始实体数组、输出实体列表。
 * 注意：SyncEntity 字段为 snake_case（与 DB 列一致）：entity_type / entity_id / updated_at。
 */
import { describe, it, expect } from 'vitest';
import {
  toSyncEntities,
  normalizeFromLocal,
  collectLocalSnapshot,
  type RawEntity,
  type NormalizedLocalData,
} from './collector-core';

describe('toSyncEntities', () => {
  it('空数据 → 空数组', () => {
    expect(toSyncEntities([])).toEqual([]);
  });

  it('画板实体带 checksum 与 updatedAt', () => {
    const raw: RawEntity[] = [
      {
        entityType: 'board',
        entityId: 'b1',
        content: { id: 'b1', name: '测试', elements: [] },
        updatedAt: 1000,
      },
    ];
    const entities = toSyncEntities(raw);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      entity_type: 'board',
      entity_id: 'b1',
      updated_at: 1000,
    });
    expect(typeof entities[0].checksum).toBe('string');
    expect(entities[0].checksum.length).toBeGreaterThan(0);
  });

  it('content 不同 → checksum 不同', () => {
    const make = (text: string) =>
      toSyncEntities([
        { entityType: 'board', entityId: 'b1', content: { name: text }, updatedAt: 1 },
      ])[0];
    expect(make('a').checksum).not.toBe(make('b').checksum);
  });

  it('缺失 updatedAt → 回退 0，仍可输出', () => {
    const entities = toSyncEntities([
      { entityType: 'task', entityId: 't1', content: {} },
    ]);
    expect(entities[0].updated_at).toBe(0);
  });

  it('null/undefined 内容 → 跳过', () => {
    const entities = toSyncEntities([
      { entityType: 'board', entityId: 'b1', content: null as never, updatedAt: 1 },
      { entityType: 'board', entityId: 'b2', content: undefined as never, updatedAt: 1 },
    ]);
    expect(entities).toHaveLength(0);
  });

  it('超大 content 不抛错且 checksum 稳定', () => {
    const big = { data: 'x'.repeat(1_000_000) };
    const a = toSyncEntities([{ entityType: 'kb_note_content', entityId: 'n1', content: big, updatedAt: 1 }])[0];
    const b = toSyncEntities([{ entityType: 'kb_note_content', entityId: 'n1', content: big, updatedAt: 1 }])[0];
    expect(a.checksum).toBe(b.checksum);
  });
});

describe('normalizeFromLocal', () => {
  it('多数据源合并为统一实体列表', () => {
    const data: NormalizedLocalData = {
      entities: [
        { entityType: 'board', entityId: 'b1', content: { id: 'b1' }, updatedAt: 10 },
        { entityType: 'task', entityId: 't1', content: { id: 't1' }, updatedAt: 20 },
      ],
      stats: { total: 2 },
    };
    const result = normalizeFromLocal(data);
    expect(result.entities.map(e => `${e.entity_type}:${e.entity_id}`)).toEqual(['board:b1', 'task:t1']);
    expect(result.stats.total).toBe(2);
  });

  it('组合型数据源（workspace_state）输出单实体', () => {
    const data: NormalizedLocalData = {
      entities: [
        { entityType: 'workspace_state', entityId: 'default', content: { currentBoardId: 'b1' }, updatedAt: 30 },
      ],
      stats: { total: 1 },
    };
    const result = normalizeFromLocal(data);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({ entity_type: 'workspace_state', entity_id: 'default' });
  });
});

describe('collectLocalSnapshot', () => {
  it('聚合多数据源，失败源不阻塞整体', async () => {
    const collector = {
      collectWorkspace: async () => ({
        entities: [{ entityType: 'board' as const, entityId: 'b1', content: {}, updatedAt: 1 }],
        stats: { total: 1 },
      }),
      collectTasks: async () => ({ entities: [], stats: { total: 0 } }),
      collectWorkflows: async () => ({ entities: [], stats: { total: 0 } }),
      collectPrompts: async () => ({ entities: [], stats: { total: 0 } }),
      collectKnowledgeBase: async () => ({ entities: [], stats: { total: 0 } }),
      collectChat: async () => ({ entities: [], stats: { total: 0 } }),
      collectAudioPlaylists: async () => ({ entities: [], stats: { total: 0 } }),
      collectCharacters: async () => ({ entities: [], stats: { total: 0 } }),
      collectAssets: async () => ({ entities: [], stats: { total: 0 } }),
      collectCacheMedia: async () => ({ entities: [], stats: { total: 0 } }),
      collectSettings: async () => ({ entities: [], stats: { total: 0 } }),
      collectCustomTools: async () => {
        throw new Error('toolbox unavailable');
      },
    };
    const result = await collectLocalSnapshot(collector);
    expect(result.entities).toHaveLength(1);
    expect(result.stats.total).toBe(1);
    expect(result.failedSources).toEqual(['customTools']);
  });
});
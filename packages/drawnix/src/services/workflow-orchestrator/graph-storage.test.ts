/**
 * graph-storage 单元测试:版本化存取/迁移/列表排序/删除。
 * IndexedDB 由 vitest.setup 的 fake-indexeddb 提供。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  deleteOrchestratorGraph,
  listOrchestratorGraphs,
  loadOrchestratorGraph,
  saveOrchestratorGraph,
} from './graph-storage';
import { createEmptyGraph, migrateGraph } from './graph-schema';
import { kvStorageService } from '../kv-storage-service';

describe('graph-storage', () => {
  beforeEach(async () => {
    // 清空 KV 命名空间
    const keys = await kvStorageService.keys();
    for (const key of keys) {
      if (String(key).startsWith('workflow_graph:')) {
        await kvStorageService.remove(String(key));
      }
    }
  });

  it('保存后读取往返一致', async () => {
    const graph = createEmptyGraph('我的编排');
    graph.nodes.push({
      id: 'n1',
      type: 'prompt',
      params: { text: 'hello' },
      geometry: { x: 10, y: 20 },
    });
    await saveOrchestratorGraph(graph);
    const loaded = await loadOrchestratorGraph(graph.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('我的编排');
    expect(loaded!.nodes).toHaveLength(1);
    expect(loaded!.nodes[0].params.text).toBe('hello');
  });

  it('读取缺失返回 null', async () => {
    await expect(loadOrchestratorGraph('nope')).resolves.toBeNull();
  });

  it('旧版本数据读取时自动迁移并补缺省字段', async () => {
    // 模拟手工/历史数据:无 schemaVersion、缺 edges/createdAt
    await kvStorageService.set('workflow_graph:legacy', {
      id: 'legacy',
      name: '旧数据',
      nodes: [{ id: 'n1', type: 'prompt', params: {}, geometry: { x: 0, y: 0 } }],
    });
    const loaded = await loadOrchestratorGraph('legacy');
    expect(loaded).not.toBeNull();
    expect(loaded!.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(loaded!.edges)).toBe(true);
  });

  it('migrateGraph 对缺字段输入兜底', () => {
    const migrated = migrateGraph({ id: 'x' });
    expect(migrated.name).toBe('未命名工作流');
    expect(migrated.nodes).toEqual([]);
    expect(migrated.edges).toEqual([]);
  });

  it('列表按 updatedAt 降序', async () => {
    const a = createEmptyGraph('A');
    const b = createEmptyGraph('B');
    await saveOrchestratorGraph({ ...a, updatedAt: 1000 });
    await saveOrchestratorGraph({ ...b, updatedAt: 2000 });
    const list = await listOrchestratorGraphs();
    expect(list.map((g) => g.name)).toEqual(['B', 'A']);
  });

  it('删除后列表不再包含', async () => {
    const graph = createEmptyGraph('待删');
    await saveOrchestratorGraph(graph);
    await deleteOrchestratorGraph(graph.id);
    await expect(loadOrchestratorGraph(graph.id)).resolves.toBeNull();
  });
});

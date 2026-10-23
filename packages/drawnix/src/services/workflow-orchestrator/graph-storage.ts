/**
 * 编排图存取:IndexedDB(aitu-storage KV)+ schemaVersion 迁移
 *
 * 与 workflow-engine 的 Workflow 存储分离:编排图是「设计态」对象(可未运行),
 * 结构与执行态步骤不同,独立 KV key 命名空间。
 */

import { kvStorageService } from '../kv-storage-service';
import { changeBus } from '../supabase-sync/change-bus';
import {
  cloudDirectStore,
  isCloudOnlyStorage,
} from '../supabase-sync/cloud-direct-store';
import {
  migrateGraph,
  ORCHESTRATOR_GRAPH_SCHEMA_VERSION,
  type OrchestratorGraph,
} from './graph-schema';

const GRAPH_KEY_PREFIX = 'workflow_graph:';

function graphKey(graphId: string): string {
  return `${GRAPH_KEY_PREFIX}${graphId}`;
}

/** 保存(整图覆盖,updatedAt 刷新) */
export async function saveOrchestratorGraph(
  graph: OrchestratorGraph
): Promise<void> {
  const payload: OrchestratorGraph = {
    ...graph,
    schemaVersion: ORCHESTRATOR_GRAPH_SCHEMA_VERSION,
    updatedAt: Date.now(),
  };
  // 云端唯一存储（remove-local-persistence 2.5）：编排图直写云端（LWW，
  // 单人编辑设计态对象；冲突保护由画板面的 CAS 承担，这里不引入多端合并）
  if (isCloudOnlyStorage()) {
    await cloudDirectStore.saveEntity('workflow_graph', graph.id, payload, {
      cas: false,
    });
    return;
  }
  await kvStorageService.set(graphKey(graph.id), payload);
  // 云同步写点（refactor-cloud-native-sync）：编排图（含 flowgram 编辑器数据）上云
  changeBus.emit('workflow_graph', graph.id, payload.updatedAt);
}

/** 读取(自动迁移到当前 schema;不存在返回 null) */
export async function loadOrchestratorGraph(
  graphId: string
): Promise<OrchestratorGraph | null> {
  // 云端唯一存储：按需单拉
  if (isCloudOnlyStorage()) {
    const raw = await cloudDirectStore.loadContent<unknown>(
      'workflow_graph',
      graphId
    );
    if (!raw) return null;
    return migrateGraph(raw);
  }
  const raw = await kvStorageService.get<unknown>(graphKey(graphId));
  if (!raw) return null;
  return migrateGraph(raw);
}

/** 列出全部编排图(按 updatedAt 降序;仅读元数据所需字段,图体随对象返回) */
export async function listOrchestratorGraphs(): Promise<OrchestratorGraph[]> {
  // 云端唯一存储：类型级拉取
  if (isCloudOnlyStorage()) {
    const graphs = await cloudDirectStore
      .listContents<OrchestratorGraph>('workflow_graph')
      .then((list) =>
        list
          .filter((graph) => graph && graph.id)
          .map((graph) => migrateGraph(graph))
      );
    graphs.sort(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
    );
    return graphs;
  }
  const keys = await kvStorageService.keys();
  const graphKeys = (keys || []).filter((k) =>
    String(k).startsWith(GRAPH_KEY_PREFIX)
  );
  const graphs: OrchestratorGraph[] = [];
  for (const key of graphKeys) {
    const raw = await kvStorageService.get<unknown>(String(key));
    if (raw) graphs.push(migrateGraph(raw));
  }
  graphs.sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  );
  return graphs;
}

/** 删除 */
export async function deleteOrchestratorGraph(graphId: string): Promise<void> {
  // 云端唯一存储：真删除
  if (isCloudOnlyStorage()) {
    await cloudDirectStore.deleteEntities([`workflow_graph:${graphId}`]);
    return;
  }
  await kvStorageService.remove(graphKey(graphId));
  changeBus.emit('workflow_graph', graphId);
}

export { ORCHESTRATOR_GRAPH_SCHEMA_VERSION };
export type { OrchestratorGraph };

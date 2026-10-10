/**
 * 编排图存取:IndexedDB(aitu-storage KV)+ schemaVersion 迁移
 *
 * 与 workflow-engine 的 Workflow 存储分离:编排图是「设计态」对象(可未运行),
 * 结构与执行态步骤不同,独立 KV key 命名空间。
 */

import { kvStorageService } from '../kv-storage-service';
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
  await kvStorageService.set(graphKey(graph.id), payload);
}

/** 读取(自动迁移到当前 schema;不存在返回 null) */
export async function loadOrchestratorGraph(
  graphId: string
): Promise<OrchestratorGraph | null> {
  const raw = await kvStorageService.get<unknown>(graphKey(graphId));
  if (!raw) return null;
  return migrateGraph(raw);
}

/** 列出全部编排图(按 updatedAt 降序;仅读元数据所需字段,图体随对象返回) */
export async function listOrchestratorGraphs(): Promise<OrchestratorGraph[]> {
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
  await kvStorageService.remove(graphKey(graphId));
}

export { ORCHESTRATOR_GRAPH_SCHEMA_VERSION };
export type { OrchestratorGraph };

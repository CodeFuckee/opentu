/**
 * 编排器图模型(schema)
 *
 * 节点画布的持久化结构:节点(类型/参数/几何位置) + 连线(端口到端口)。
 * schemaVersion 从第一天强制:读取旧版本时按迁移函数逐版升级,避免存量大图报废。
 */

/** 当前图 schema 版本:破坏性变更时 +1 并在 GRAPH_MIGRATIONS 补迁移函数 */
export const ORCHESTRATOR_GRAPH_SCHEMA_VERSION = 1;

/** M1 节点数上限:防误操作拖垮主线程 */
export const MAX_GRAPH_NODES = 64;

/** 节点类型名(M1 三类 8 种) */
export type OrchestratorNodeTypeName =
  | 'prompt'
  | 'reference-image'
  | 'model-picker'
  | 'image-generation'
  | 'image-variation'
  | 'insert-canvas'
  | 'save-library'
  | 'preview';

export interface OrchestratorNode {
  id: string;
  type: OrchestratorNodeTypeName;
  /** 未连线字段的面板值(连线字段编译期生成占位符,运行期由引擎解析) */
  params: Record<string, unknown>;
  /** 画布几何位置(React Flow 坐标) */
  geometry: { x: number; y: number };
}

export interface OrchestratorEdge {
  id: string;
  source: string;
  /** 源端口 id(如 image-generation 的 outputs:images) */
  sourcePort: string;
  target: string;
  /** 目标端口 id(如 image-generation 的 inputs:referenceImages) */
  targetPort: string;
}

export interface OrchestratorGraph {
  id: string;
  name: string;
  schemaVersion: number;
  nodes: OrchestratorNode[];
  edges: OrchestratorEdge[];
  createdAt: number;
  updatedAt: number;
}

/** 创建空白图 */
export function createEmptyGraph(name = '未命名工作流'): OrchestratorGraph {
  const now = Date.now();
  return {
    id: `wfg_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    schemaVersion: ORCHESTRATOR_GRAPH_SCHEMA_VERSION,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  };
}

type GraphMigration = (graph: Record<string, unknown>) => Record<string, unknown>;

/**
 * 逐版迁移表:key 为来源版本,值为迁移到下一版本的函数。
 * 约定:迁移必须纯函数、缺字段补默认值,不做业务推断。
 */
export const GRAPH_MIGRATIONS: Record<number, GraphMigration> = {
  // v1 为首个版本;示例(v1→v2): (g) => ({ ...g, newField: defaultValue })
};

/**
 * 把任意(可能过期/缺字段的)持久化结构升级到当前 schema。
 * 未知更高版本原样返回并保留其版本号(向前兼容由部署侧保证)。
 */
export function migrateGraph(raw: unknown): OrchestratorGraph {
  let graph = { ...(raw as Record<string, unknown>) };
  let version = typeof graph.schemaVersion === 'number' ? graph.schemaVersion : 1;
  while (version < ORCHESTRATOR_GRAPH_SCHEMA_VERSION) {
    const migrate = GRAPH_MIGRATIONS[version];
    graph = migrate ? migrate(graph) : graph;
    version += 1;
  }
  graph.schemaVersion = version;
  // 缺省字段兜底(手工编辑/半截数据不至于崩)
  if (!Array.isArray(graph.nodes)) graph.nodes = [];
  if (!Array.isArray(graph.edges)) graph.edges = [];
  if (typeof graph.name !== 'string' || !graph.name) graph.name = '未命名工作流';
  if (typeof graph.id !== 'string' || !graph.id) graph.id = `wfg_${Date.now()}`;
  if (typeof graph.createdAt !== 'number') graph.createdAt = Date.now();
  if (typeof graph.updatedAt !== 'number') graph.updatedAt = Date.now();
  return graph as unknown as OrchestratorGraph;
}

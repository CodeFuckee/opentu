/**
 * flowgram-adapter 单元测试:双向转换/roundtrip/坏数据防御。
 */
import { describe, expect, it } from 'vitest';
import {
  fromFlowgramDocument,
  toFlowgramDocument,
  type FlowgramDocumentJSON,
} from './flowgram-adapter';
import {
  createEmptyGraph,
  type OrchestratorGraph,
} from './graph-schema';

function buildGraph(): OrchestratorGraph {
  const graph = createEmptyGraph('测试图');
  graph.nodes.push(
    {
      id: 'n1',
      type: 'prompt',
      params: { text: '一只猫' },
      geometry: { x: 10, y: 20 },
    },
    {
      id: 'n2',
      type: 'image-generation',
      params: { model: 'gpt-image', count: 2 },
      geometry: { x: 300, y: 0 },
    },
    {
      id: 'n3',
      type: 'save-library',
      params: {},
      geometry: { x: 600, y: 0 },
    }
  );
  graph.edges.push(
    {
      id: 'e1',
      source: 'n1',
      sourcePort: 'outputs:text',
      target: 'n2',
      targetPort: 'inputs:prompt',
    },
    {
      id: 'e2',
      source: 'n2',
      sourcePort: 'outputs:images',
      target: 'n3',
      targetPort: 'inputs:images',
    }
  );
  return graph;
}

describe('toFlowgramDocument', () => {
  it('节点映射:id/type/data/meta.position', () => {
    const doc = toFlowgramDocument(buildGraph());
    expect(doc.nodes).toHaveLength(3);
    const n1 = doc.nodes[0];
    expect(n1.id).toBe('n1');
    expect(n1.type).toBe('prompt');
    expect(n1.data).toEqual({ text: '一只猫' });
    expect(n1.meta?.position).toEqual({ x: 10, y: 20 });
  });

  it('连线映射:端口 id 原文透传', () => {
    const doc = toFlowgramDocument(buildGraph());
    expect(doc.edges[0]).toEqual({
      sourceNodeID: 'n1',
      targetNodeID: 'n2',
      sourcePortID: 'outputs:text',
      targetPortID: 'inputs:prompt',
    });
  });

  it('params 拷贝为独立对象(修改互不影响)', () => {
    const graph = buildGraph();
    const doc = toFlowgramDocument(graph);
    (doc.nodes[0].data as Record<string, unknown>).text = '改过的';
    expect(graph.nodes[0].params.text).toBe('一只猫');
  });
});

describe('fromFlowgramDocument', () => {
  it('roundtrip:图 → 文档 → 图 保持节点/连线/参数/几何一致', () => {
    const graph = buildGraph();
    const doc = toFlowgramDocument(graph);
    const back = fromFlowgramDocument(doc, {
      id: graph.id,
      name: graph.name,
      createdAt: graph.createdAt,
    });
    expect(back.id).toBe(graph.id);
    expect(back.name).toBe(graph.name);
    expect(back.nodes).toEqual(graph.nodes);
    expect(back.edges.map((e) => [e.source, e.sourcePort, e.target, e.targetPort])).toEqual(
      graph.edges.map((e) => [e.source, e.sourcePort, e.target, e.targetPort])
    );
    expect(back.edges.every((e) => e.id)).toBe(true);
  });

  it('丢弃未知类型节点及其孤立连线', () => {
    const doc: FlowgramDocumentJSON = {
      nodes: [
        { id: 'ok', type: 'prompt', data: {}, meta: { position: { x: 1, y: 2 } } },
        { id: 'bad', type: 'future-type', data: {} },
      ],
      edges: [
        {
          sourceNodeID: 'ok',
          targetNodeID: 'bad',
          sourcePortID: 'outputs:text',
          targetPortID: 'inputs:prompt',
        },
      ],
    };
    const graph = fromFlowgramDocument(doc, { id: 'g', name: 'x', createdAt: 1 });
    expect(graph.nodes.map((n) => n.id)).toEqual(['ok']);
    expect(graph.edges).toHaveLength(0);
  });

  it('丢弃缺端口 id 的连线', () => {
    const doc: FlowgramDocumentJSON = {
      nodes: [
        { id: 'a', type: 'prompt', data: {} },
        { id: 'b', type: 'image-generation', data: {} },
      ],
      edges: [
        {
          sourceNodeID: 'a',
          targetNodeID: 'b',
          sourcePortID: 'outputs:text',
          targetPortID: 'inputs:prompt',
        },
        { sourceNodeID: 'a', targetNodeID: 'b' },
      ],
    };
    const graph = fromFlowgramDocument(doc, { id: 'g', name: 'x', createdAt: 1 });
    expect(graph.edges).toHaveLength(1);
  });

  it('坏数据防御:非数组/缺字段/缺几何不抛错', () => {
    const graph = fromFlowgramDocument(
      { nodes: [null, { id: '', type: 'prompt' }, { id: 'ok', type: 'prompt' }], edges: 'bad' as never },
      { id: 'g', name: '', createdAt: 1 }
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].geometry).toEqual({ x: 0, y: 0 });
    expect(graph.edges).toEqual([]);
    expect(graph.name).toBe('未命名工作流');
  });
});

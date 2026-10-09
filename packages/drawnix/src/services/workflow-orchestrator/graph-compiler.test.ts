/**
 * graph-compiler 单元测试:节点图 → WorkflowStep[] 编译。
 * 覆盖:正常编译/静态参数内联/运行时占位符/环检测/端口类型与存在性/
 * 多下游分发/空图/节点数上限/未知节点类型。
 */
import { describe, expect, it } from 'vitest';
import {
  compileGraph,
  CompilerError,
  type GraphInput,
} from './graph-compiler';
import {
  createEmptyGraph,
  MAX_GRAPH_NODES,
  type OrchestratorGraph,
} from './graph-schema';

function build(
  mutate: (g: OrchestratorGraph) => void,
  name = '测试图'
): GraphInput {
  const g = createEmptyGraph(name);
  mutate(g);
  return g;
}

function addNode(
  g: OrchestratorGraph,
  id: string,
  type: OrchestratorGraph['nodes'][number]['type'],
  params: Record<string, unknown> = {},
  geometry = { x: 0, y: 0 }
) {
  g.nodes.push({ id, type, params, geometry });
}

function addEdge(
  g: OrchestratorGraph,
  id: string,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string
) {
  g.edges.push({ id, source, sourcePort, target, targetPort });
}

describe('compileGraph:正常编译', () => {
  it('提示词+模型+文生图+存素材库 编译为 2 个步骤,静态参数内联', () => {
    const graph = build((g) => {
      addNode(g, 'p1', 'prompt', { text: '一只柴犬在草地上' });
      addNode(g, 'm1', 'model-picker', {
        model: 'gpt-image-1',
        size: '1024x1024',
        count: 4,
      });
      addNode(g, 'gen1', 'image-generation', {});
      addNode(g, 'save1', 'save-library', {});
      addEdge(g, 'e1', 'p1', 'outputs:text', 'gen1', 'inputs:prompt');
      addEdge(g, 'e2', 'm1', 'outputs:model', 'gen1', 'inputs:model');
      addEdge(g, 'e3', 'gen1', 'outputs:images', 'save1', 'inputs:images');
    });
    const { steps, stepNodeIds } = compileGraph(graph);
    expect(steps).toHaveLength(2);
    expect(steps[0].mcp).toBe('generate_image');
    expect(steps[0].args.prompt).toBe('一只柴犬在草地上');
    expect(steps[0].args.model).toBe('gpt-image-1');
    expect(steps[0].args.size).toBe('1024x1024');
    expect(steps[0].args.count).toBe(4);
    expect(steps[0].dependsOn).toEqual([]);
    // 存素材库:依赖生图步骤,URL 用运行时占位符
    expect(steps[1].mcp).toBe('archive_media');
    expect(steps[1].dependsOn).toEqual([steps[0].id]);
    expect(steps[1].args.urls).toBe(`{{${steps[0].id}.urls}}`);
    // stepId → nodeId 映射
    expect(stepNodeIds[steps[0].id]).toBe('gen1');
    expect(stepNodeIds[steps[1].id]).toBe('save1');
  });

  it('生成节点连参考图节点时,参考图 URL 内联为 referenceImages', () => {
    const graph = build((g) => {
      addNode(g, 'ref1', 'reference-image', { url: 'http://ex.com/a.png' });
      addNode(g, 'gen1', 'image-variation', { prompt: '换成夜景' });
      addEdge(g, 'e1', 'ref1', 'outputs:image', 'gen1', 'inputs:referenceImages');
    });
    const { steps } = compileGraph(graph);
    expect(steps).toHaveLength(1);
    expect(steps[0].mcp).toBe('generate_image');
    expect(steps[0].args.generationMode).toBe('image_edit');
    expect(steps[0].args.referenceImages).toEqual(['http://ex.com/a.png']);
  });

  it('插入画布节点编译为 insert_images 主线程步骤', () => {
    const graph = build((g) => {
      addNode(g, 'gen1', 'image-generation', { prompt: 'x' });
      addNode(g, 'ins1', 'insert-canvas', {});
      addEdge(g, 'e1', 'gen1', 'outputs:images', 'ins1', 'inputs:images');
    });
    const { steps } = compileGraph(graph);
    expect(steps[1].mcp).toBe('insert_images');
    expect(steps[1].dependsOn).toEqual([steps[0].id]);
  });

  it('一个生成节点分发给多个下游(存库+插画布),下游互为兄弟依赖', () => {
    const graph = build((g) => {
      addNode(g, 'gen1', 'image-generation', { prompt: 'x' });
      addNode(g, 'save1', 'save-library', {});
      addNode(g, 'ins1', 'insert-canvas', {});
      addEdge(g, 'e1', 'gen1', 'outputs:images', 'save1', 'inputs:images');
      addEdge(g, 'e2', 'gen1', 'outputs:images', 'ins1', 'inputs:images');
    });
    const { steps } = compileGraph(graph);
    expect(steps).toHaveLength(3);
    const genStep = steps[0];
    const downstream = steps.filter((s) => s.mcp !== 'generate_image');
    for (const s of downstream) {
      expect(s.dependsOn).toEqual([genStep.id]);
    }
  });

  it('无任何生成节点的纯输出图:编译为 0 步骤且不报错', () => {
    const graph = build((g) => {
      addNode(g, 'p1', 'prompt', { text: 'x' });
    });
    const { steps } = compileGraph(graph);
    expect(steps).toEqual([]);
  });
});

describe('compileGraph:校验失败', () => {
  it('环检测:互相依赖的连线报 CompilerError 并定位到边', () => {
    const graph = build((g) => {
      addNode(g, 'gen1', 'image-generation', { prompt: 'a' });
      addNode(g, 'gen2', 'image-generation', { prompt: 'b' });
      addEdge(g, 'e1', 'gen1', 'outputs:images', 'gen2', 'inputs:referenceImages');
      addEdge(g, 'e2', 'gen2', 'outputs:images', 'gen1', 'inputs:referenceImages');
    });
    expect(() => compileGraph(graph)).toThrow(CompilerError);
    expect(() => compileGraph(graph)).toThrow(/环|cycle/i);
  });

  it('连线引用不存在的节点报错', () => {
    const graph = build((g) => {
      addNode(g, 'gen1', 'image-generation', { prompt: 'x' });
      addEdge(g, 'e1', 'ghost', 'outputs:images', 'gen1', 'inputs:referenceImages');
    });
    expect(() => compileGraph(graph)).toThrow(/ghost|不存在/);
  });

  it('端口类型不匹配报错(图片输出口连到提示词输入口)', () => {
    const graph = build((g) => {
      addNode(g, 'gen1', 'image-generation', { prompt: 'x' });
      addNode(g, 'p1', 'prompt', { text: 'y' });
      addEdge(g, 'e1', 'gen1', 'outputs:images', 'p1', 'inputs:text');
    });
    expect(() => compileGraph(graph)).toThrow(CompilerError);
  });

  it('连线引用不存在的端口报错', () => {
    const graph = build((g) => {
      addNode(g, 'p1', 'prompt', { text: 'x' });
      addNode(g, 'gen1', 'image-generation', {});
      addEdge(g, 'e1', 'p1', 'outputs:nope', 'gen1', 'inputs:prompt');
    });
    expect(() => compileGraph(graph)).toThrow(/端口|port/i);
  });

  it('未知节点类型报错', () => {
    const graph = build((g) => {
      addNode(g, 'bad', 'quantum-node' as never, {});
    });
    expect(() => compileGraph(graph)).toThrow(/未知节点类型/);
  });

  it('超过节点数上限报错', () => {
    const graph = build((g) => {
      for (let i = 0; i <= MAX_GRAPH_NODES; i++) {
        addNode(g, `n${i}`, 'prompt', { text: 'x' });
      }
    });
    expect(() => compileGraph(graph)).toThrow(/上限/);
  });

  it('文生图节点缺 prompt(未连线也未填)报错', () => {
    const graph = build((g) => {
      addNode(g, 'gen1', 'image-generation', {});
      addNode(g, 'save1', 'save-library', {});
      addEdge(g, 'e1', 'gen1', 'outputs:images', 'save1', 'inputs:images');
    });
    expect(() => compileGraph(graph)).toThrow(/prompt|提示词/i);
  });
});

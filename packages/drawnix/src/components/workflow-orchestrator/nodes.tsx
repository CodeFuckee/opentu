/**
 * 编排画布节点组件:单一动态节点按类型渲染(M1 三类 8 种)。
 * 紧凑卡片:类型头 + 关键参数内联编辑 + 运行态条;端口用 React Flow Handle。
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { OrchestratorNode, OrchestratorNodeTypeName } from '../../services/workflow-orchestrator/graph-schema';
import { NODE_TYPE_SPECS } from '../../services/workflow-orchestrator/graph-compiler';

/** 节点运行状态(来自引擎事件;undefined=未参与本次运行) */
export type OrchestratorRunStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface OrchestratorNodeData extends Record<string, unknown> {
  node: OrchestratorNode;
  status?: OrchestratorRunStatus;
  error?: string;
  /** 运行完成后上游产出的图片 URL(preview 等节点展示用) */
  resultUrls?: string[];
  onParamChange: (nodeId: string, key: string, value: unknown) => void;
}

export type OrchestratorFlowNode = Node<OrchestratorNodeData, 'orchestrator'>;

const TYPE_LABELS: Record<OrchestratorNodeTypeName, string> = {
  prompt: '提示词',
  'reference-image': '参考图',
  'model-picker': '模型与参数',
  'image-generation': '文生图',
  'image-variation': '基于图生成',
  'insert-canvas': '插入画布',
  'save-library': '存素材库',
  preview: '预览',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '等待',
  running: '运行中',
  completed: '完成',
  failed: '失败',
};

function Port({
  portId,
  position,
  kind,
  index,
  total,
}: {
  portId: string;
  position: Position;
  kind: string;
  index: number;
  total: number;
}) {
  // React Flow 默认把同侧 Handle 都放在 top:50%——多端口会完全重叠
  // (DOM 靠后者遮住前面),必须按序纵向分布
  const top = `${((index + 1) / (total + 1)) * 100}%`;
  return (
    <Handle
      type={position === Position.Right ? 'source' : 'target'}
      position={position}
      id={portId}
      style={{ top }}
      className={`wf-orch-port wf-orch-port--${kind.includes('[]') ? 'multi' : 'single'}`}
    />
  );
}

function OrchestratorNodeViewInner({ data }: NodeProps<OrchestratorFlowNode>) {
  const { node, status, error, resultUrls, onParamChange } = data;
  const spec = NODE_TYPE_SPECS[node.type];
  if (!spec) {
    return <div className="wf-orch-node wf-orch-node--unknown">未知节点</div>;
  }

  const setParam = (key: string, value: unknown) =>
    onParamChange(node.id, key, value);

  const statusClass = status ? `wf-orch-node--${status}` : '';

  return (
    <div className={`wf-orch-node ${statusClass}`} data-node-type={node.type}>
      {/* 输入端口(左侧,纵向分布) */}
      {spec.inputs.map((port, i) => (
        <Port
          key={port.id}
          portId={port.id}
          position={Position.Left}
          kind={port.kind}
          index={i}
          total={spec.inputs.length}
        />
      ))}

      <div className="wf-orch-node__header">
        <span className="wf-orch-node__title">{TYPE_LABELS[node.type]}</span>
        {status && (
          <span className={`wf-orch-node__status wf-orch-status--${status}`}>
            {STATUS_LABELS[status] ?? status}
          </span>
        )}
      </div>

      <div className="wf-orch-node__body">
        {node.type === 'prompt' && (
          <textarea
            className="wf-orch-input"
            value={(node.params.text as string) ?? ''}
            placeholder="输入提示词…"
            rows={3}
            onChange={(e) => setParam('text', e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        )}
        {node.type === 'reference-image' && (
          <input
            className="wf-orch-input"
            value={(node.params.url as string) ?? ''}
            placeholder="图片 URL(或从素材库复制)"
            onChange={(e) => setParam('url', e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        )}
        {node.type === 'model-picker' && (
          <div className="wf-orch-node__fields">
            <input
              className="wf-orch-input"
              value={(node.params.model as string) ?? ''}
              placeholder="模型名(如 gpt-image-1)"
              onChange={(e) => setParam('model', e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
            />
            <div className="wf-orch-node__row">
              <input
                className="wf-orch-input"
                value={(node.params.size as string) ?? ''}
                placeholder="尺寸 1024x1024"
                onChange={(e) => setParam('size', e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
              />
              <input
                className="wf-orch-input wf-orch-input--narrow"
                type="number"
                min={1}
                max={8}
                value={(node.params.count as number) ?? 1}
                onChange={(e) => setParam('count', Number(e.target.value) || 1)}
                onPointerDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        )}
        {(node.type === 'image-generation' || node.type === 'image-variation') && (
          <textarea
            className="wf-orch-input"
            value={(node.params.prompt as string) ?? ''}
            placeholder="未连线时可在此填写提示词"
            rows={2}
            onChange={(e) => setParam('prompt', e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        )}
        {(node.type === 'insert-canvas' || node.type === 'save-library') && (
          <div className="wf-orch-node__hint">连接左侧图片组端口</div>
        )}
        {node.type === 'preview' && (
          <div className="wf-orch-node__preview">
            {resultUrls && resultUrls.length > 0 ? (
              resultUrls.slice(0, 4).map((u) => (
                <img key={u} src={u} alt="result" className="wf-orch-node__thumb" />
              ))
            ) : (
              <div className="wf-orch-node__hint">运行后展示上游生成结果</div>
            )}
          </div>
        )}
      </div>

      {error && <div className="wf-orch-node__error">{error}</div>}

      {/* 输出端口(右侧,纵向分布) */}
      {spec.outputs.map((port, i) => (
        <Port
          key={port.id}
          portId={port.id}
          position={Position.Right}
          kind={port.kind}
          index={i}
          total={spec.outputs.length}
        />
      ))}
    </div>
  );
}

export const OrchestratorNodeView = memo(OrchestratorNodeViewInner);

/** React Flow nodeTypes 映射(单一动态类型) */
export const orchestratorNodeTypes = {
  orchestrator: OrchestratorNodeView,
};

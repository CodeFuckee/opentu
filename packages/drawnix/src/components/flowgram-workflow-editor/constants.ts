/**
 * Flowgram 编辑器常量:节点类型展示信息与端口布局。
 *
 * 单一事实源是 graph-compiler 的 NODE_TYPE_SPECS(端口/类型/直通标记),
 * 这里只补 UI 层信息(中文名/尺寸/端口垂直分布)。
 */
import type { ComponentType } from 'react';
import {
  AIImageIcon,
  ImageIcon,
  InsertToCanvasIcon,
  MediaLibraryIcon,
  PromptIcon,
  ImageEditIcon,
  SettingsIcon,
  ViewIcon,
} from '../icons';
import { NODE_TYPE_SPECS, type PortDef } from '../../services/workflow-orchestrator/graph-compiler';
import type { OrchestratorNodeTypeName } from '../../services/workflow-orchestrator/graph-schema';

export interface FlowgramPortJSON {
  portID?: string | number;
  type: 'input' | 'output';
  locationConfig?: {
    left?: string | number;
    top?: string | number;
    right?: string | number;
    bottom?: string | number;
  };
}

/** 类型中文名(与画布原生节点/编排面板一致) */
export const NODE_TYPE_LABELS: Record<OrchestratorNodeTypeName, string> = {
  prompt: '提示词',
  'reference-image': '参考图',
  'model-picker': '模型与参数',
  'image-generation': '文生图',
  'image-variation': '基于图生成',
  'insert-canvas': '插入画布',
  'save-library': '存素材库',
  preview: '预览',
};

/** 节点分类:输入(直通) / 生成(执行) / 输出(落地) —— 驱动 header 分类色 */
export type NodeCategory = 'input' | 'generate' | 'output';

export const NODE_TYPE_CATEGORIES: Record<OrchestratorNodeTypeName, NodeCategory> = {
  prompt: 'input',
  'reference-image': 'input',
  'model-picker': 'input',
  'image-generation': 'generate',
  'image-variation': 'generate',
  preview: 'output',
  'insert-canvas': 'output',
  'save-library': 'output',
};

/** 类型图标(仓库 lucide 体系,组件接口含 size) */
export const NODE_TYPE_ICONS: Record<OrchestratorNodeTypeName, ComponentType<{ size?: number }>> = {
  prompt: PromptIcon,
  'reference-image': ImageIcon,
  'model-picker': SettingsIcon,
  'image-generation': AIImageIcon,
  'image-variation': ImageEditIcon,
  preview: ViewIcon,
  'insert-canvas': InsertToCanvasIcon,
  'save-library': MediaLibraryIcon,
};

/** 左侧面板展示顺序:直通输入 → 生成 → 落地/输出 */
export const NODE_PANEL_ORDER: OrchestratorNodeTypeName[] = [
  'prompt',
  'reference-image',
  'model-picker',
  'image-generation',
  'image-variation',
  'preview',
  'insert-canvas',
  'save-library',
];

/** 各类型节点卡片尺寸(宽固定,高按内容) */
export const NODE_TYPE_SIZES: Record<OrchestratorNodeTypeName, { width: number; height: number }> = {
  prompt: { width: 260, height: 150 },
  'reference-image': { width: 260, height: 130 },
  'model-picker': { width: 260, height: 160 },
  'image-generation': { width: 280, height: 170 },
  'image-variation': { width: 280, height: 170 },
  'insert-canvas': { width: 240, height: 110 },
  'save-library': { width: 240, height: 110 },
  preview: { width: 280, height: 160 },
};

/** 按 NODE_TYPE_SPECS 派生某类型的端口定义(带垂直均分的定位) */
export function getPortsOfType(type: OrchestratorNodeTypeName): FlowgramPortJSON[] {
  const spec = NODE_TYPE_SPECS[type];
  if (!spec) return [];
  const distribute = (ports: PortDef[]): FlowgramPortJSON[] =>
    ports.map((port, index) => ({
      portID: port.id,
      type: 'input' as const,
      locationConfig: {
        left: 0,
        top: `${((index + 1) / (ports.length + 1)) * 100}%`,
      },
    }));
  const distributeOutputs = (ports: PortDef[]): FlowgramPortJSON[] =>
    ports.map((port, index) => ({
      portID: port.id,
      type: 'output' as const,
      locationConfig: {
        right: 0,
        top: `${((index + 1) / (ports.length + 1)) * 100}%`,
      },
    }));
  return [...distribute(spec.inputs), ...distributeOutputs(spec.outputs)];
}

/** 端口数据类型(连线校验用);未知端口返回 null */
export function getPortKind(
  type: string,
  portId: string
): 'text' | 'model' | 'image' | 'image[]' | null {
  const spec = NODE_TYPE_SPECS[type];
  if (!spec) return null;
  const port = [...spec.inputs, ...spec.outputs].find((p) => p.id === portId);
  return port?.kind ?? null;
}

/** 端口类型兼容规则(与编译器 isKindCompatible 一致) */
export function isPortKindCompatible(source: string, target: string): boolean {
  if (source === target) return true;
  return source === 'image' && target === 'image[]';
}

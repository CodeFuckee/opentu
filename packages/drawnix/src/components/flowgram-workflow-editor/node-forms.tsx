/**
 * 节点表单:flowgram form engine 渲染(节点卡片内联 + 右侧栏两种布局)。
 *
 * Field 名与编译器内联读取的参数键一致(prompt.text / reference-image.url /
 * model-picker.model|size|count / 生成节点.prompt),编辑器保存的 data 即
 * OrchestratorNode.params,零转换。
 */
import React, { useContext } from 'react';
import {
  Field,
  type FieldRenderProps,
  type FormMeta,
} from '@flowgram.ai/free-layout-editor';

import type { OrchestratorNodeTypeName } from '../../services/workflow-orchestrator/graph-schema';

/** 右侧栏挂载时由 Sidebar 提供(true);节点卡片内默认 false */
export const IsSidebarContext = React.createContext(false);

interface FieldProps<T> {
  value: T;
  onChange: (value: T) => void;
}

const TextField: React.FC<FieldProps<string> & { placeholder?: string; rows?: number }> = ({
  value,
  onChange,
  placeholder,
  rows = 3,
}) => (
  <textarea
    className="fwf-field-input"
    value={value ?? ''}
    placeholder={placeholder}
    rows={rows}
    onChange={(e) => onChange(e.target.value)}
    onPointerDown={(e) => e.stopPropagation()}
  />
);

const NumberField: React.FC<FieldProps<number> & { min?: number; max?: number }> = ({
  value,
  onChange,
  min = 1,
  max = 8,
}) => (
  <input
    className="fwf-field-input fwf-field-input--narrow"
    type="number"
    min={min}
    max={max}
    value={value ?? min}
    onChange={(e) => onChange(Number(e.target.value) || min)}
    onPointerDown={(e) => e.stopPropagation()}
  />
);

const PromptField = ({ name, placeholder }: { name: string; placeholder: string }) => (
  <Field<string> name={name}>
    {({ field: { value, onChange } }: FieldRenderProps<string>) => (
      <TextField value={value} onChange={onChange} placeholder={placeholder} />
    )}
  </Field>
);

/** 节点内联表单(卡片主体) */
const InlineFormBody: React.FC<{ type: OrchestratorNodeTypeName }> = ({ type }) => {
  switch (type) {
    case 'prompt':
      return <PromptField name="text" placeholder="输入提示词…" />;
    case 'reference-image':
      return <PromptField name="url" placeholder="图片 URL…" />;
    case 'model-picker':
      return (
        <>
          <Field<string> name="model">
            {({ field: { value, onChange } }: FieldRenderProps<string>) => (
              <input
                className="fwf-field-input"
                value={value ?? ''}
                placeholder="模型名（可留空）"
                onChange={(e) => onChange(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
              />
            )}
          </Field>
          <div className="fwf-node-form-row">
            <span className="fwf-field-label">数量</span>
            <Field<number> name="count">
              {({ field: { value, onChange } }: FieldRenderProps<number>) => (
                <NumberField value={value} onChange={onChange} min={1} max={8} />
              )}
            </Field>
          </div>
        </>
      );
    case 'image-generation':
      return <PromptField name="prompt" placeholder="未连线时可在此填写提示词" />;
    case 'image-variation':
      return <PromptField name="prompt" placeholder="描述如何基于参考图生成" />;
    case 'preview':
      return <div className="fwf-node-hint">运行后在此预览上游图片</div>;
    case 'insert-canvas':
      return <div className="fwf-node-hint">运行后图片插入主画布（编辑器内需回画布执行）</div>;
    case 'save-library':
      return <div className="fwf-node-hint">运行后图片存入素材库</div>;
    default:
      return null;
  }
};

/** 右侧栏表单内容(标题由侧栏外壳渲染,此处不再重复) */
const SidebarFormBody: React.FC<{ type: OrchestratorNodeTypeName }> = ({ type }) => (
  <div className="fwf-sidebar-form">
    <div className="fwf-sidebar-form__body">
      <InlineFormBody type={type} />
      {type === 'image-generation' || type === 'image-variation' ? (
        <>
          <div className="fwf-field-label">模型覆盖（留空走 model-picker/默认）</div>
          <Field<string> name="model">
            {({ field: { value, onChange } }: FieldRenderProps<string>) => (
              <input
                className="fwf-field-input"
                value={value ?? ''}
                placeholder="模型名"
                onChange={(e) => onChange(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
              />
            )}
          </Field>
          <div className="fwf-node-form-row">
            <span className="fwf-field-label">数量</span>
            <Field<number> name="count">
              {({ field: { value, onChange } }: FieldRenderProps<number>) => (
                <NumberField value={value} onChange={onChange} />
              )}
            </Field>
          </div>
        </>
      ) : null}
    </div>
  </div>
);

/** 按挂载布局(IsSidebarContext)切换表单体;hook 只能在组件里调用 */
const FormBodyByLayout: React.FC<{ type: OrchestratorNodeTypeName }> = ({ type }) => {
  const isSidebar = useContext(IsSidebarContext);
  return isSidebar ? <SidebarFormBody type={type} /> : <InlineFormBody type={type} />;
};

/** 按 M1 节点类型构造 formMeta(内联/侧栏双布局) */
export function createFormMeta(type: OrchestratorNodeTypeName): FormMeta {
  return {
    render: () => <FormBodyByLayout type={type} />,
  };
}

/** 未知类型的兜底 formMeta(从旧版本数据/未来类型进来不至于崩) */
export const fallbackFormMeta: FormMeta = {
  render: () => <div className="fwf-node-hint">未知节点类型</div>,
};

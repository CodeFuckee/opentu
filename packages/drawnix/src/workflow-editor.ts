/**
 * @drawnix/drawnix/workflow-editor 子入口
 *
 * /workflow 全屏视图专用:Flowgram 编辑器及其依赖(含 reflect-metadata,
 * 必须最先 import)只进本 chunk,主画布首屏零加载。
 */
import 'reflect-metadata';

export { WorkflowEditorApp, default } from './components/flowgram-workflow-editor';

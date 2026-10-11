/**
 * 工作流节点组件类:Plait 元素生命周期 → 渲染器(参照 audio-node.component)
 */
import {
  ACTIVE_STROKE_WIDTH,
  OnContextChanged,
  PlaitBoard,
  PlaitPluginElementContext,
  RectangleClient,
  SELECTION_RECTANGLE_CLASS_NAME,
  createG,
  drawRectangle,
  toActiveRectangleFromViewBoxRectangle,
} from '@plait/core';
import {
  CommonElementFlavour,
  Generator,
} from '@plait/common';
import type { PlaitWorkflowNode } from '../../types/workflow-node.types';
import { WorkflowNodeGenerator } from './workflow-node.generator';

interface WorkflowNodeSelectionData {
  selected: boolean;
}

class WorkflowNodeSelectionGenerator extends Generator<
  PlaitWorkflowNode,
  WorkflowNodeSelectionData
> {
  canDraw(_element: PlaitWorkflowNode, data?: WorkflowNodeSelectionData): boolean {
    return Boolean(data?.selected);
  }

  draw(element: PlaitWorkflowNode): SVGGElement {
    const selectionG = createG();
    const rectangle = RectangleClient.getRectangleByPoints(element.points);
    const activeRectangle = toActiveRectangleFromViewBoxRectangle(
      this.board,
      rectangle
    );
    const activeRectangleWithDelta = RectangleClient.inflate(
      activeRectangle,
      ACTIVE_STROKE_WIDTH
    );
    const strokeG = drawRectangle(this.board, activeRectangleWithDelta, {
      stroke: '#b45309',
      strokeWidth: ACTIVE_STROKE_WIDTH,
    });

    if (strokeG) {
      strokeG.classList.add(SELECTION_RECTANGLE_CLASS_NAME);
      strokeG.style.opacity = '0.9';
      selectionG.append(strokeG);
    }

    return selectionG;
  }
}

export class WorkflowNodeComponent
  extends CommonElementFlavour<PlaitWorkflowNode, PlaitBoard>
  implements OnContextChanged<PlaitWorkflowNode, PlaitBoard>
{
  private nodeGenerator!: WorkflowNodeGenerator;
  private activeGenerator!: WorkflowNodeSelectionGenerator;
  private renderedG?: SVGGElement;

  initializeGenerator(): void {
    this.activeGenerator = new WorkflowNodeSelectionGenerator(this.board, {
      active: true,
    });
    this.nodeGenerator = new WorkflowNodeGenerator();
  }

  initialize(): void {
    super.initialize();
    this.initializeGenerator();

    const elementG = this.getElementG();
    this.renderedG = this.nodeGenerator.processDrawing(
      this.element,
      elementG,
      this.board
    );

    this.activeGenerator.processDrawing(
      this.element,
      PlaitBoard.getActiveHost(this.board),
      { selected: this.selected }
    );
  }

  onContextChanged(
    value: PlaitPluginElementContext<PlaitWorkflowNode, PlaitBoard>,
    previous: PlaitPluginElementContext<PlaitWorkflowNode, PlaitBoard>
  ): void {
    const viewportChanged =
      value.board.viewport.zoom !== previous.board.viewport.zoom ||
      value.board.viewport.offsetX !== previous.board.viewport.offsetX ||
      value.board.viewport.offsetY !== previous.board.viewport.offsetY;

    if (value.element !== previous.element || value.hasThemeChanged) {
      if (this.renderedG) {
        this.nodeGenerator.updateDrawing(
          this.element,
          this.renderedG,
          this.board
        );
      }
      this.activeGenerator.processDrawing(
        this.element,
        PlaitBoard.getActiveHost(this.board),
        { selected: this.selected }
      );
    } else if (viewportChanged && value.selected) {
      this.activeGenerator.processDrawing(
        this.element,
        PlaitBoard.getActiveHost(this.board),
        { selected: this.selected }
      );
    } else {
      const needUpdate = value.selected !== previous.selected;
      if (needUpdate && this.renderedG) {
        this.nodeGenerator.updateDrawing(
          this.element,
          this.renderedG,
          this.board
        );
      }
      this.activeGenerator.processDrawing(
        this.element,
        PlaitBoard.getActiveHost(this.board),
        { selected: this.selected }
      );
    }
  }

  destroy(): void {
    this.nodeGenerator.destroy();
    // 选中矩形画在 activeHost 图层(g.active-host-g),不在元素自己的 g 里——
    // 框架删除元素时只移除元素 g,漏掉这步会把 #b45309 选中边框永久留在画布
    // (参照 audio-node.component 的 destroy)
    this.activeGenerator.destroy();
    super.destroy();
  }
}

/**
 * 工作流节点渲染器:foreignObject + React(参照 audio-node.generator)
 */
import { RectangleClient } from '@plait/core';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import type { PlaitBoard } from '@plait/core';
import type { PlaitWorkflowNode } from '../../types/workflow-node.types';
import { WorkflowNodeContent } from './WorkflowNodeContent';
import { workflowRunService } from '../../services/workflow-orchestrator/workflow-run-service';

export class WorkflowNodeGenerator {
  private foreignObject: SVGForeignObjectElement | null = null;
  private htmlContainer: HTMLElement | null = null;
  private reactRoot: Root | null = null;

  processDrawing(element: PlaitWorkflowNode, parentG: SVGGElement, board: PlaitBoard): SVGGElement {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'workflow-node-element');
    parentG.appendChild(g);
    this.createForeignObject(element, g);
    this.renderReact(element, board);
    return g;
  }

  updateDrawing(element: PlaitWorkflowNode, _g: SVGGElement, board: PlaitBoard): void {
    this.updateForeignObject(element);
    this.renderReact(element, board);
  }

  private createForeignObject(element: PlaitWorkflowNode, g: SVGGElement): void {
    const rect = RectangleClient.getRectangleByPoints(element.points);
    this.foreignObject = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'foreignObject'
    );
    this.foreignObject.setAttribute('x', String(rect.x));
    this.foreignObject.setAttribute('y', String(rect.y));
    this.foreignObject.setAttribute('width', String(rect.width));
    this.foreignObject.setAttribute('height', String(rect.height));
    this.foreignObject.style.overflow = 'visible';
    this.foreignObject.style.pointerEvents = 'auto';

    this.htmlContainer = document.createElementNS(
      'http://www.w3.org/1999/xhtml',
      'div'
    ) as HTMLElement;
    this.htmlContainer.style.cssText = `
      width: 100%;
      height: 100%;
      pointer-events: auto;
      overflow: visible;
    `;
    this.foreignObject.appendChild(this.htmlContainer);
    g.appendChild(this.foreignObject);
  }

  private updateForeignObject(element: PlaitWorkflowNode): void {
    if (!this.foreignObject) return;
    const rect = RectangleClient.getRectangleByPoints(element.points);
    this.foreignObject.setAttribute('x', String(rect.x));
    this.foreignObject.setAttribute('y', String(rect.y));
    this.foreignObject.setAttribute('width', String(rect.width));
    this.foreignObject.setAttribute('height', String(rect.height));
  }

  private renderReact(element: PlaitWorkflowNode, board: PlaitBoard): void {
    if (!this.htmlContainer) return;
    if (!this.reactRoot) {
      this.reactRoot = createRoot(this.htmlContainer);
    }
    this.reactRoot.render(
      React.createElement(WorkflowNodeContent, {
        element,
        board,
        runService: workflowRunService,
      })
    );
  }

  destroy(): void {
    if (this.reactRoot) {
      const root = this.reactRoot;
      this.reactRoot = null;
      setTimeout(() => {
        try {
          root.unmount();
        } catch {
          // Ignore unmount failures during teardown.
        }
      }, 0);
    }
    this.foreignObject = null;
    this.htmlContainer = null;
  }
}

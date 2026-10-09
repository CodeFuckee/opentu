/**
 * 工作流编排系统 E2E(@functional)
 *
 * 覆盖 M1 用户路径(编排/持久化):
 * - P0 工具箱打开「工作流编排」→ 添加节点 → 连线 → 保存 → 刷新 → 打开列表
 *   → 重新打开,节点/连线完整恢复;
 * - P1 空图运行提示「没有可执行的节点」。
 * 生成执行链路由单测 mock 覆盖(引擎/编译器),E2E 不依赖真实模型与 API Key。
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test-base';

async function openOrchestrator(page: Page) {
  await page.getByTestId('toolbar-toolbox').click();
  const drawer = page.locator('.side-drawer--toolbar-right').first();
  await expect(drawer).toBeVisible({ timeout: 8000 });
  await drawer.getByRole('button', { name: /AI 工具/ }).click();
  const toolItem = drawer
    .locator('.toolbox-drawer__content')
    .getByText('工作流编排', { exact: false })
    .first();
  await expect(toolItem).toBeVisible({ timeout: 8000 });
  await toolItem.click();
  const canvas = page.locator('[data-testid="workflow-orchestrator"]');
  await expect(canvas).toBeVisible({ timeout: 10000 });
  return canvas;
}

async function addNode(page: Page, label: string) {
  const scope = page.getByTestId('workflow-orchestrator');
  await scope.getByText('添加节点 ▾').click();
  await scope.getByRole('button', { name: label }).click();
}

/** 节点上的端口(React Flow 12 渲染 data-handleid 属性) */
function portOf(page: Page, nodeText: string, portId: string) {
  return page
    .locator(`.react-flow__node:has-text("${nodeText}")`)
    .locator(`.react-flow__handle[data-handleid="${portId}"]`)
    .first();
}

async function dragPortToPort(
  page: Page,
  from: { node: string; port: string },
  to: { node: string; port: string }
) {
  const fromHandle = portOf(page, from.node, from.port);
  const toHandle = portOf(page, to.node, to.port);
  const fb = await fromHandle.boundingBox();
  expect(fb).toBeTruthy();
  await page.mouse.move(fb!.x + fb!.width / 2, fb!.y + fb!.height / 2);
  await page.mouse.down();
  // 终点坐标在 mouse.up 前实时重测(fitView/布局动画会挪动端口位置)
  const tb = await toHandle.boundingBox();
  expect(tb).toBeTruthy();
  await page.mouse.move(tb!.x + tb!.width / 2, tb!.y + tb!.height / 2, { steps: 6 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test.describe('工作流编排系统', () => {
  test('P0 搭建生图编排并保存,刷新后完整恢复', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });
    for (let i = 0; i < 5; i++) {
      if (
        await page
          .getByRole('button', { name: '不再提示' })
          .isVisible({ timeout: 400 })
          .catch(() => false)
      ) {
        await page.getByRole('button', { name: '不再提示' }).click();
        break;
      }
    }

    await openOrchestrator(page);

    await addNode(page, '提示词');
    await addNode(page, '模型与参数');
    await addNode(page, '文生图');
    await addNode(page, '存素材库');
    const canvas = page.locator('[data-testid="workflow-orchestrator"]');
    await expect(canvas.locator('.wf-orch-node')).toHaveCount(4);

    // 连线:提示词→文生图,模型参数→文生图,文生图→存素材库
    await dragPortToPort(
      page,
      { node: '提示词', port: 'outputs:text' },
      { node: '文生图', port: 'inputs:prompt' }
    );
    await dragPortToPort(
      page,
      { node: '模型与参数', port: 'outputs:model' },
      { node: '文生图', port: 'inputs:model' }
    );
    await dragPortToPort(
      page,
      { node: '文生图', port: 'outputs:images' },
      { node: '存素材库', port: 'inputs:images' }
    );

    // 填写提示词与模型
    await canvas.locator('[data-node-type="prompt"] textarea').fill('一只柴犬在草地上奔跑');
    await canvas.locator('[data-node-type="model-picker"] input').first().fill('gpt-image-1');

    // 命名并保存
    await page.getByPlaceholder('工作流名称').fill('E2E 编排用例');
    await page.getByText('保存', { exact: true }).click();
    await expect(
      page.locator('.t-message', { hasText: '已保存' })
    ).toBeVisible({ timeout: 8000 });

    // 刷新后从列表打开,节点与连线完整恢复
    await page.reload();
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });
    const canvas2 = await openOrchestrator(page);
    await page.getByText('打开', { exact: true }).click();
    const item = page.locator('.wf-orch-list__item', { hasText: 'E2E 编排用例' });
    await expect(item).toBeVisible({ timeout: 8000 });
    await item.locator('.wf-orch-list__name').click();
    await expect(canvas2.locator('.wf-orch-node')).toHaveCount(4, { timeout: 8000 });
    expect(await canvas2.locator('.react-flow__edge').count()).toBe(3);
    await page.screenshot({ path: 'reports/workflow-orchestrator-restore.png' });
  });

  test('P1 空图运行提示「没有可执行的节点」', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({ timeout: 15000 });
    await openOrchestrator(page);
    await page.getByTestId('wf-orch-run').click();
    await expect(
      page.locator('.t-message', { hasText: '没有可执行的节点' })
    ).toBeVisible({ timeout: 8000 });
  });
});

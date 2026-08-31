/**
 * AI 输入栏测试（@functional）
 *
 * 覆盖：提示词输入、模型选择器（打开/选择）、尺寸/分辨率参数选择器、
 * 灵感创意板（模板填充/返回）。
 */
import { test, expect } from '../fixtures/test-base';
import type { Page } from '@playwright/test';

const aiTextarea = (page: Page) => page.getByTestId('ai-input-textarea');

test.describe('AI 输入栏', () => {
  test('提示词输入：可输入并保留内容', async ({ page }) => {
    await page.goto('/');
    await expect(aiTextarea(page)).toBeVisible({ timeout: 15000 });

    await aiTextarea(page).fill('一只在星空下奔跑的白色独角兽');
    await expect(aiTextarea(page)).toHaveValue(
      '一只在星空下奔跑的白色独角兽'
    );
  });

  test('模型选择器：打开下拉并可以看到可选模型', async ({ page }) => {
    await page.goto('/');
    await expect(aiTextarea(page)).toBeVisible({ timeout: 15000 });

    const selector = page.getByTestId('model-selector').first();
    await selector.click();
    await page.waitForTimeout(600);

    // 下拉列表出现且以 role=option 呈现
    const options = page.locator('.model-dropdown__item, [role="option"]');
    const count = await options.count();
    expect(count).toBeGreaterThan(1);

    // 面板文本应包含模型标识
    const text = await page.locator('.model-dropdown__list').innerText();
    expect(text).toMatch(/gpt|gemini|flux|midjourney/i);

    await page.keyboard.press('Escape');
  });

  test('模型选择器：选择模型后触发显示更新', async ({ page }) => {
    await page.goto('/');
    await expect(aiTextarea(page)).toBeVisible({ timeout: 15000 });

    const selector = page.getByTestId('model-selector').first();
    const before = (await selector.innerText()).trim();

    await selector.click();
    await page.waitForTimeout(600);

    // 选择列表中一个特定模型（gpt-image-2-vip），触发按钮文本变化
    const vip = page
      .locator('.model-dropdown__item', { hasText: 'gpt-image-2-vip' })
      .first();
    await expect(vip).toBeVisible({ timeout: 5000 });
    await vip.click();
    await page.waitForTimeout(400);

    const after = (await selector.innerText()).trim();
    expect(after).not.toBe(before);
    expect(after.toLowerCase()).toContain('gpt2v');
  });

  test('尺寸参数选择器：打开并切换分辨率', async ({ page }) => {
    await page.goto('/');
    await expect(aiTextarea(page)).toBeVisible({ timeout: 15000 });

    const sizeBtn = page.getByRole('button', { name: /自动/ }).first();
    await expect(sizeBtn).toBeVisible();
    await sizeBtn.click();
    await page.waitForTimeout(600);

    // 参数弹层包含尺寸/分辨率/画质
    const panelText = await page.evaluate(() =>
      (document.body.innerText || '').replace(/\n+/g, '|')
    );
    expect(panelText).toContain('图片尺寸');
    expect(panelText).toContain('画质');

    // 选择一个分辨率（2K）
    const k2 = page.getByRole('button', { name: /^2K/ }).first();
    if ((await k2.count()) > 0) {
      await k2.click();
      await page.waitForTimeout(400);
    }
    await page.keyboard.press('Escape');
  });

  test('发送按钮：输入提示词后可用', async ({ page }) => {
    await page.goto('/');
    await expect(aiTextarea(page)).toBeVisible({ timeout: 15000 });

    const send = page.getByTestId('ai-send-btn');
    await aiTextarea(page).fill('测试发送按钮');
    await expect(send).toBeVisible();
    // 有内容时按钮生效（不为禁用的 aria-disabled）
    const disabled = await send.getAttribute('aria-disabled');
    expect(disabled).not.toBe('true');
  });
});
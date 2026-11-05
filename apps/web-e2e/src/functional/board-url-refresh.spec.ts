/**
 * 刷新带 board 参数的链接必须停留在原画布（bug 回归）
 *
 * 用户场景（2026-11-05，8089 预览真机）：访问 http://<host>/?board=<uuid> 后刷新，
 * URL 的 board 参数被替换为新种默认板的 uuid——每次刷新都「新建」一块画布。
 *
 * 本用例复现完整链路：登录 → 新建画板（URL 得到 ?board=<id>）→ reload →
 * 断言 URL board 参数不变、画板树非空、不出现「原画板数据未能加载」降级提示。
 * 同时收集 console 告警/错误、pageerror 与 user_sync_data 网络请求，作为诊断附件输出。
 */
import { appendFileSync, readFileSync } from 'fs';
import { test, expect, type Page } from '@playwright/test';
import {
  loginViaUi,
  openProjectDrawer,
  createNamedBoard,
  randomBoardName,
  enableCloudOnlyStorage,
  countBoardsInDrawer,
} from '../fixtures/cloud-sync-helpers';
import { ensureE2EAccountRegistered, getTestAccount } from '../fixtures/e2e-auth';

/** 收集诊断信息：console 告警/错误、pageerror、user_sync_data 网络请求（同步落盘，防 teardown 丢事件） */
function attachDiagnostics(page: Page, sinkPath: string): void {
  const sink = (line: string) => {
    try {
      appendFileSync(sinkPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // 忽略写盘失败
    }
  };
  page.on('console', (msg) => {
    const text = msg.text();
    if (
      msg.type() === 'warning' ||
      msg.type() === 'error' ||
      text.includes('[App]') ||
      text.includes('云端')
    ) {
      sink(`[console.${msg.type()}] ${text}`);
    }
  });
  page.on('pageerror', (error) => {
    sink(`[pageerror] ${error.message}`);
  });
  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('user_sync_data')) {
      return;
    }
    sink(`[req ${request.method()}] ${url}`);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('user_sync_data')) {
      return;
    }
    const status = response.status();
    // 响应体异步读，读完再落一行（读失败也有状态行不丢）
    response
      .text()
      .then((body) => {
        const summary =
          body.length > 400
            ? `${body.slice(0, 400)}…(len=${body.length})`
            : body;
        sink(`[res ${status}] ${url}\n    → ${summary}`);
      })
      .catch(() => {
        sink(`[res ${status}] ${url}\n    → (body 不可读)`);
      });
  });
}

test.describe('带 board 参数刷新停留在原画布', () => {
  test('刷新后 URL board 参数不变且不新建画布', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(600_000);

    const boardName = randomBoardName();
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    const sinkPath = testInfo.outputPath('console-diagnostics.log');
    attachDiagnostics(page, sinkPath);
    const readLogs = (): string => {
      try {
        return readFileSync(sinkPath, 'utf8');
      } catch {
        return '(无诊断记录)';
      }
    };
    const logLine = (line: string): void => {
      try {
        appendFileSync(sinkPath, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // 忽略
      }
    };

    await enableCloudOnlyStorage(page);
    await loginViaUi(page, account.id);

    // 新建画板：切换后 URL 应带 ?board=<id>
    await openProjectDrawer(page);
    await createNamedBoard(page, boardName);
    await page.waitForTimeout(2_500); // 等防抖保存落云

    const urlBefore = new URL(page.url());
    const boardIdBefore = urlBefore.searchParams.get('board');
    expect(boardIdBefore, '新建画板后 URL 应包含 board 参数').toBeTruthy();
    const boardCountBefore = await countBoardsInDrawer(page);

    // ============ 用户场景：原样刷新 ============
    logLine(`[test] reload 前 URL: ${page.url()}`);
    await page.reload();
    await expect(page.getByTestId('unified-toolbar')).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(2_500); // 等初始化兜底链全部走完

    const urlAfter = new URL(page.url());
    const boardIdAfter = urlAfter.searchParams.get('board');
    logLine(`[test] reload 后 URL: ${page.url()}`);
    logLine(`[test] board 参数: 前=${boardIdBefore} 后=${boardIdAfter}`);

    // 诊断输出（无论成败都附件，便于定位是哪一环兜底）
    await testInfo.attach('console-diagnostics', {
      body: readLogs(),
      contentType: 'text/plain',
    });

    // 核心断言：刷新必须停留在原画布
    expect(
      boardIdAfter,
      `刷新后 board 参数被改变（${boardIdBefore} → ${boardIdAfter}），初始化未按 URL 参数恢复原画布`
    ).toBe(boardIdBefore);

    // 不得偷偷新建画板（种默认板兜底只允许发生在工作区确为空时）
    await openProjectDrawer(page);
    const boardCountAfter = await countBoardsInDrawer(page);
    expect(
      boardCountAfter,
      `刷新后画板数量增加（${boardCountBefore} → ${boardCountAfter}），初始化悄悄新建了画布`
    ).toBe(boardCountBefore);

    // 画板树非空（原画板仍在）
    await openProjectDrawer(page);
    await expect(
      page
        .getByTestId('project-drawer')
        .getByText(boardName, { exact: true })
        .first()
    ).toBeVisible({ timeout: 30_000 });

    // 不得出现降级种新板的提示
    await expect(page.getByText('原画板数据未能加载')).toHaveCount(0);

    const boardCount = await countBoardsInDrawer(page);
    logLine(`[test] 画板树画板数: ${boardCount}`);

    await context.close();
  });
});

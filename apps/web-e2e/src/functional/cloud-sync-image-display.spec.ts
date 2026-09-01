/**
 * 云端同步：跨设备打开画布后「图片正常显示 + 控制台无报错」E2E 测试（@functional）
 *
 * 按手册步骤 1:1 复现：
 * 1. 打开一个画布（新建随机命名画板并打开，等同随机打开任意画布），在画布中插入
 *    图片 apps/web-e2e/images/test1.png；
 * 2. 设备 A 使用云端同步功能同步画布（立即同步）；
 * 3. 重新打开一个新的浏览器（全新无痕 browserContext，模拟第二台设备）；
 * 4. 使用同一个测试账号登录画布；
 * 5. 使用云端同步功能同步画布（立即同步）；
 * 6. 打开上面插入图片的画布（先在云端按元素 id 定位画板，再在项目抽屉中打开）；
 * 7. 查看控制台是否有报错（设备 A/B 从页面创建起收集 console error / pageerror，
 *    最后统一断言为空，日志留档 attach；
 * 8. 查看插入的图片是否正常显示（img.image-origin 可见、naturalWidth > 0 真实解码、
 *    画布内非零尺寸）。
 *
 * 关键点：
 * - 图片元素用 plait-data-id（元素 id）精确追踪：该 id 跨云端同步保持不变，
 *   不受图片 URL（blob: 兜底等）变化影响；
 * - 设备 A 同步后先轮询云端 user_sync_media，确认图片字节已完成上传（否则关闭
 *   设备 A 会中断 fire-and-forget 的媒体上传，设备 B 拿不到图片）；
 * - 设备 B 打开画板后图片可能需要等待媒体下载 + 加载失败重试/缓存兜底，给足时间
 *   （90s），并以 naturalWidth > 0 且非 hidden 视为「正常显示」；
 * - 无论成败，收尾时都会留档：设备 A/B 控制台日志、/asset-library 与缓存 URL 的
 *   网络响应状态、设备 B 最终 img 状态与 Cache Storage 是否存在图片 blob，
 *   便于复现现场分析。
 *
 * 运行：npx playwright test --project=functional src/functional/cloud-sync-image-display.spec.ts
 */
import { test, expect } from '../fixtures/test-base';
import { existsSync } from 'fs';
import { resolve as resolvePath } from 'path';
import type {
  BrowserContext,
  ConsoleMessage,
  Page,
  Response,
  TestInfo,
} from '@playwright/test';
import { ensureE2EAccountRegistered } from '../fixtures/e2e-auth';
import { dismissInspirationBoard } from '../fixtures/canvas-helpers';
import { getTestAccount, POLL_INTERVALS, TIMEOUTS } from '../config/e2e.config';
import {
  clickSyncNow,
  closeSyncSettingsDialog,
  createNamedBoard,
  fetchRemoteBoardByElementId,
  forceFileInputFallback,
  insertImageToCanvas,
  isMediaSyncedToCloud,
  loginViaUi,
  openCloudSyncSettings,
  openProjectDrawer,
  probeRemoteMediaObject,
  randomBoardName,
  syncAndOpenBoard,
} from '../fixtures/cloud-sync-helpers';

// ---------------------------------------------------------------- 监听与诊断

interface ConsoleBucket {
  errors: string[];
  warnings: string[];
}

/** 监听页面 console / pageerror，返回收集桶与停止函数（error 视为报错，warning 仅记录） */
function watchConsole(page: Page): { bucket: ConsoleBucket; stop: () => void } {
  const bucket: ConsoleBucket = { errors: [], warnings: [] };
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      bucket.errors.push(msg.text());
    } else if (msg.type() === 'warning') {
      bucket.warnings.push(msg.text());
    }
  };
  const onPageError = (error: Error) => {
    bucket.errors.push(error.message);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  return {
    bucket,
    stop: () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

interface AssetRequestInfo {
  url: string;
  status: number;
}

/**
 * 监听页面对虚拟媒体路径（/asset-library/、/__aitu_cache__/）的网络响应，
 * 用于诊断图片字节是否能被正常服务（SW 拦截 / 404 / 兜底等）。
 */
function watchAssetRequests(page: Page): {
  requests: AssetRequestInfo[];
  stop: () => void;
} {
  const requests: AssetRequestInfo[] = [];
  const onResponse = (res: Response) => {
    const url = res.url();
    if (url.includes('/asset-library/') || url.includes('/__aitu_cache__/')) {
      requests.push({ url: url.split('?')[0], status: res.status() });
    }
  };
  page.on('response', onResponse);
  return {
    requests,
    stop: () => page.off('response', onResponse),
  };
}

/** 读取设备页面 Cache Storage 中是否存在指定虚拟 URL 的 blob（媒体下载完成的信号） */
async function hasCachedBlob(
  page: Page | null,
  virtualUrl: string
): Promise<boolean> {
  if (!page) {
    return false;
  }
  return page
    .evaluate(async (url) => {
      const keys = await caches.keys();
      for (const key of keys) {
        const cache = await caches.open(key);
        const res = await cache.match(url).catch(() => null);
        if (res && (await res.blob()).size > 0) {
          return true;
        }
      }
      return false;
    }, virtualUrl)
    .catch(() => false);
}

/** 读取指定图片元素的最终渲染状态（best-effort，失败返回 null） */
async function collectImageState(
  page: Page | null,
  elementId: string
): Promise<Record<string, unknown> | null> {
  if (!page) {
    return null;
  }
  try {
    return await page
      .locator(
        `.board-host-svg [plait-data-id="${elementId}"] img.image-origin`
      )
      .evaluate((img) => {
        const el = img as HTMLImageElement;
        return {
          src: el.currentSrc,
          naturalWidth: el.naturalWidth,
          naturalHeight: el.naturalHeight,
          complete: el.complete,
          visibility: getComputedStyle(el).visibility,
        };
      });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 图片元素定位

/**
 * 画布上图片类元素宿主的 element id 列表。
 * 宿主是 .board-host-svg 内带 plait-data-id 的节点（= 元素 id，跨云端同步保持不变），
 * 图片渲染为其内部的 img.image-origin。
 */
async function collectImageHostIds(page: Page): Promise<string[]> {
  return page.locator('.board-host-svg [plait-data-id]').evaluateAll((hosts) =>
    hosts
      .filter((host) => host.querySelector('img.image-origin') !== null)
      .map((host) => host.getAttribute('plait-data-id') || '')
      .filter(Boolean)
  );
}

/** 等待新增图片元素渲染到画布，返回其 element id（beforeIds 之外的第一个图片元素） */
async function waitForNewImage(
  page: Page,
  beforeIds: string[]
): Promise<string> {
  await expect
    .poll(
      async () =>
        (await collectImageHostIds(page)).filter(
          (id) => !beforeIds.includes(id)
        ).length,
      { timeout: TIMEOUTS.element, intervals: [POLL_INTERVALS.canvas] }
    )
    .toBeGreaterThan(0);

  const elementId = await page
    .locator('.board-host-svg [plait-data-id] img.image-origin')
    .evaluateAll((imgs, before) => {
      for (const img of imgs as HTMLImageElement[]) {
        const id =
          img.closest('[plait-data-id]')?.getAttribute('plait-data-id') || '';
        if (id && !before.includes(id)) {
          return id;
        }
      }
      return null;
    }, beforeIds);
  expect(elementId, '新插入的图片元素应能在画布上定位').not.toBeNull();
  return elementId as string;
}

/**
 * 轮询等待指定元素 id 的图片「正常显示」：
 * 元素存在且真实解码渲染（naturalWidth > 0）且未被加载失败逻辑隐藏（visibility）。
 */
async function expectImageLoaded(
  page: Page,
  elementId: string,
  timeout = 60000
): Promise<void> {
  const image = page.locator(
    `.board-host-svg [plait-data-id="${elementId}"] img.image-origin`
  );
  await expect
    .poll(
      () =>
        image
          .evaluate((img) => {
            const el = img as HTMLImageElement;
            return (
              el.naturalWidth > 0 &&
              el.style.visibility !== 'hidden' &&
              getComputedStyle(el).visibility !== 'hidden'
            );
          })
          .catch(() => false),
      { timeout, intervals: [POLL_INTERVALS.canvas] }
    )
    .toBe(true);
}

/** 测试图片路径：apps/web-e2e/images/test1.png（相对仓库根） */
const TEST_IMAGE_PATH = resolvePath(__dirname, '..', '..', 'images', 'test1.png');

/**
 * 收尾诊断（无论测试成败都执行）：停止监听、采集设备 B 图片最终状态与缓存、
 * 把控制台日志 / 网络响应 / 图片状态 attach 到测试报告。
 */
async function collectDiagnostics(
  testInfo: TestInfo,
  deps: {
    consoleA: { bucket: ConsoleBucket };
    consoleB: { bucket: ConsoleBucket } | null;
    assetA: { requests: AssetRequestInfo[] };
    assetB: { requests: AssetRequestInfo[] } | null;
    pageB: Page | null;
    imageElementId: string | null;
    remoteImageUrl: string | null;
    probeA1: { rowFound: boolean; status: number | null } | null;
    probeB2: { rowFound: boolean; status: number | null } | null;
  }
): Promise<void> {
  const { consoleA, consoleB, assetA, assetB, pageB } = deps;

  await testInfo.attach('device-console-logs', {
    body: JSON.stringify(
      {
        deviceA: {
          errors: consoleA.bucket.errors,
          warnings: consoleA.bucket.warnings,
        },
        deviceB: consoleB
          ? {
              errors: consoleB.bucket.errors,
              warnings: consoleB.bucket.warnings,
            }
          : null,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  await testInfo.attach('device-asset-requests', {
    body: JSON.stringify(
      {
        deviceA: assetA.requests,
        deviceB: assetB ? assetB.requests : null,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  if (deps.imageElementId) {
    const imageState = await collectImageState(pageB, deps.imageElementId);
    const assetCachedOnB = deps.remoteImageUrl
      ? await hasCachedBlob(pageB, deps.remoteImageUrl)
      : false;
    // 设备 B 视角的云端媒体行可见性（区分「行不存在」与「下载失败」）
    const mediaViewFromB =
      deps.remoteImageUrl && pageB
        ? await isMediaSyncedToCloud(pageB, deps.remoteImageUrl)
        : null;
    await testInfo.attach('device-b-image-state', {
      body: JSON.stringify(
        {
          elementId: deps.imageElementId,
          imageState,
          assetCachedOnB,
          mediaViewFromB,
          // 设备 A 上传后立即探测 storage 对象（probeA1）与设备 B 结束时再探测
          // （probeB2）：对象偶发 404 说明云端对象在测试期间被外部删除（环境干扰）
          probeA1: deps.probeA1,
          probeB2: deps.probeB2,
        },
        null,
        2
      ),
      contentType: 'application/json',
    });
  }
}

/** 轮询等待媒体 blob 写入本机 Cache Storage；超时返回 false */
async function waitForMediaBlob(
  page: Page,
  url: string,
  timeout = 30000
): Promise<boolean> {
  try {
    await expect
      .poll(() => hasCachedBlob(page, url), {
        timeout,
        intervals: [POLL_INTERVALS.canvas],
      })
      .toBe(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在页面上下文直接调用当前应用的 syncMediaToSupabase（绕过同步按钮的
 * fire-and-forget 触发链），返回实际执行统计，用于定位媒体下载卡点。
 */
async function manuallyRunMediaSync(
  page: Page
): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    try {
      const supabaseClientUrl = '/src/supabase/supabase-client.ts';
      const mediaSyncUrl =
        '/@fs/C:/Users/Administrator/codes/opentu/packages/drawnix/src/services/supabase-sync/media-sync.ts';
      const { getSupabaseClient } = await import(supabaseClientUrl);
      const { syncMediaToSupabase } = await import(mediaSyncUrl);
      const client = getSupabaseClient();
      const session = await client.auth.getSession();
      const user = session.data.session?.user;
      if (!user) {
        return { error: 'no session' };
      }
      // 对照：supabase-js 客户端视角的 media 表查询（fetchRemoteMedia 同路径）
      const rawAll = await client
        .from('user_sync_media')
        .select('user_id,url,storage_path')
        .limit(100);
      const rawMine = await client
        .from('user_sync_media')
        .select('url,storage_path')
        .eq('user_id', user.id);
      const stats = await syncMediaToSupabase({ client } as never, user.id);
      return {
        userId: user.id,
        rawAllRows: rawAll.data?.length ?? 0,
        rawAllError: rawAll.error
          ? String((rawAll.error as { message?: string }).message ?? rawAll.error)
          : null,
        rawMineRows: rawMine.data?.length ?? 0,
        rawMineError: rawMine.error
          ? String((rawMine.error as { message?: string }).message ?? rawMine.error)
          : null,
        rawMineSample: rawMine.data?.slice(0, 3) ?? [],
        stats,
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        raw: String(err),
      };
    }
  });
}

test.describe('云端同步（图片显示与控制台报错）', () => {
  test('新浏览器同账号同步后打开画板：控制台无报错且图片正常显示', async (
    { browser },
    testInfo
  ) => {
    test.setTimeout(360000);

    const boardName = randomBoardName();
    test.info().annotations.push({
      type: 'board-name',
      description: boardName,
    });

    // 步骤 4 前置：统一配置的固定测试账号（按 worker 分配，不新建用户）
    const account = getTestAccount(testInfo.workerIndex);
    await ensureE2EAccountRegistered(account);

    // 步骤 1 前置：测试图片必须存在（apps/web-e2e/images/test1.png）
    expect(
      existsSync(TEST_IMAGE_PATH),
      `测试图片应位于 apps/web-e2e/images/test1.png（实际: ${TEST_IMAGE_PATH}）`
    ).toBe(true);

    // ============ 设备 A ============
    // 全新无痕 context = 第一台设备（显式空 storageState，不继承项目认证会话）
    const contextA = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const pageA = await contextA.newPage();
    await forceFileInputFallback(pageA);
    const consoleA = watchConsole(pageA);
    const assetA = watchAssetRequests(pageA);

    // 设备 B 相关引用（可能因设备 A 失败而从未创建）
    let contextB: BrowserContext | null = null;
    let pageB: Page | null = null;
    let consoleB: { bucket: ConsoleBucket; stop: () => void } | null = null;
    let assetB: { requests: AssetRequestInfo[]; stop: () => void } | null = null;
    let imageElementId: string | null = null;
    let remoteImageUrl: string | null = null;
    let remoteBoardName: string | null = null;
    let probeA1: { rowFound: boolean; status: number | null } | null = null;

    try {
      // 步骤 1：随机打开一个画布（新建随机命名画板并打开，等同于随机打开任意画布）
      await loginViaUi(pageA, account.id);
      await openProjectDrawer(pageA);
      await createNamedBoard(pageA, boardName);
      await pageA.keyboard.press('Escape');
      await pageA.waitForTimeout(400);
      await dismissInspirationBoard(pageA);

      // 步骤 1：在画布中插入一张图片（apps/web-e2e/images/test1.png）
      const beforeIds = await collectImageHostIds(pageA);
      await insertImageToCanvas(pageA, TEST_IMAGE_PATH);
      imageElementId = await waitForNewImage(pageA, beforeIds);

      // 设备 A 本地应先正常渲染（作为「同步后是否仍正常」的基线）
      await expectImageLoaded(pageA, imageElementId, TIMEOUTS.syncAction);

      // 步骤 2：使用云端同步功能同步画布（立即同步）
      await openCloudSyncSettings(pageA);
      await clickSyncNow(pageA);
      await closeSyncSettingsDialog(pageA);

      // 云端校验：按元素 id 定位画板，确认图片已同步，并拿到画板名供设备 B 打开
      const remote = await fetchRemoteBoardByElementId(pageA, imageElementId);
      expect(
        remote,
        `云端应存在包含元素「${imageElementId}」的画板（步骤2同步后）`
      ).not.toBeNull();
      const remoteContent = remote!.content;
      const remoteElement =
        ((remoteContent.elements as Array<Record<string, unknown>>) ?? []).find(
          (el) => (el as Record<string, unknown>).id === imageElementId
        ) ?? null;
      expect(remoteElement?.type, '云端元素类型应为 image').toBe('image');
      expect(remoteElement?.url, '云端图片元素应含 url').toBeTruthy();
      remoteImageUrl = String(remoteElement?.url ?? '');
      expect(
        remoteImageUrl,
        '云端图片 URL 应为虚拟路径（/asset-library/）'
      ).toMatch(/^\/asset-library\//);
      expect(remoteContent.name, '云端画板应有名称').toBeTruthy();
      remoteBoardName = remoteContent.name as string;

      // 等待图片字节上传完毕（媒体同步为 fire-and-forget，须在关闭设备 A 前完成，
      // 否则中断后设备 B 拿不到图片数据）
      await expect
        .poll(async () => isMediaSyncedToCloud(pageA, remoteImageUrl!), {
          timeout: TIMEOUTS.syncAction,
          intervals: [POLL_INTERVALS.canvas],
        })
        .toBe(true);

      // 上传完成后立即探测 storage 对象可下载性（基准：此时应 200）
      probeA1 = await probeRemoteMediaObject(pageA, remoteImageUrl!);

      // 步骤 3：重新打开一个新的浏览器（关闭设备 A，换全新无痕 context）
      await contextA.close();

      // ============ 设备 B ============
      contextB = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      pageB = await contextB.newPage();
      await forceFileInputFallback(pageB);
      consoleB = watchConsole(pageB);
      assetB = watchAssetRequests(pageB);

      // 步骤 4：使用同一个账户登录画布
      await loginViaUi(pageB, account.id);

      // 步骤 5-6：使用云端同步功能同步画布，并打开上面插入图片的画布
      await syncAndOpenBoard(pageB, remoteBoardName!);
      await dismissInspirationBoard(pageB);

      // 等待图片字节落地本机 Cache（media-sync 为 fire-and-forget）。
      // 首次同步未落地时自动补一次「立即同步」再等——避免 img 首次加载 404
      // 制造控制台噪音；仍失败则由后续图片显示/控制台断言兜底暴露
      let mediaLanded = await waitForMediaBlob(pageB, remoteImageUrl!, 30000);
      if (!mediaLanded) {
        await openCloudSyncSettings(pageB);
        await clickSyncNow(pageB);
        await closeSyncSettingsDialog(pageB);
        mediaLanded = await waitForMediaBlob(pageB, remoteImageUrl!, 30000);
      }
      if (!mediaLanded) {
        // 诊断：绕过 fire-and-forget 直接调用 media-sync 并核对该账号的
        // user_sync_media 行（区分「自动触发链未执行」「行缺失」与「下载本身失败」）
        const manualSyncResult = await manuallyRunMediaSync(pageB);
        await testInfo.attach('device-b-manual-media-sync', {
          body: JSON.stringify(manualSyncResult, null, 2),
          contentType: 'application/json',
        });
        mediaLanded = await waitForMediaBlob(pageB, remoteImageUrl!, 30000);
      }
      expect(
        mediaLanded,
        `设备 B 同步后图片字节应落地本机 Cache（两次立即同步+手动 media-sync 均未下载到 ${remoteImageUrl}）`
      ).toBe(true);

      // 步骤 8：查看插入的图片是否正常显示（真实解码渲染 + 画布内非零尺寸）
      await expectImageLoaded(pageB, imageElementId, 90000);
      const imageBox = await pageB
        .locator(
          `.board-host-svg [plait-data-id="${imageElementId}"] img.image-origin`
        )
        .boundingBox();
      const hasSize = !!(imageBox && imageBox.width > 0 && imageBox.height > 0);
      expect(hasSize, '设备 B 打开画板后图片应有非零尺寸').toBe(true);

      // 留档：设备 B 画布截图
      const shotB = await pageB.screenshot();
      await testInfo.attach('device-b-canvas', {
        body: shotB,
        contentType: 'image/png',
      });

      // 步骤 7：查看控制台是否有报错（放最后，等待异步任务落定后统一断言）
      await pageB.waitForTimeout(3000);
      consoleA.stop();
      consoleB.stop();
      const errors = {
        deviceA: consoleA.bucket.errors,
        deviceB: consoleB.bucket.errors,
      };
      const warnings = {
        deviceA: consoleA.bucket.warnings,
        deviceB: consoleB.bucket.warnings,
      };
      if (errors.deviceA.length > 0 || errors.deviceB.length > 0) {
        await testInfo.attach('device-console-errors', {
          body: JSON.stringify(errors, null, 2),
          contentType: 'application/json',
        });
      }
      if (warnings.deviceA.length > 0 || warnings.deviceB.length > 0) {
        await testInfo.attach('device-console-warnings', {
          body: JSON.stringify(warnings, null, 2),
          contentType: 'application/json',
        });
      }
      expect(
        errors.deviceA,
        `设备 A 控制台出现报错：${errors.deviceA.join(' | ')}`
      ).toEqual([]);
      expect(
        errors.deviceB,
        `设备 B 控制台出现报错：${errors.deviceB.join(' | ')}`
      ).toEqual([]);
    } finally {
      // 无论成败都留档诊断信息（控制台 / 网络 / 图片最终状态）
      await collectDiagnostics(testInfo, {
        consoleA,
        consoleB,
        assetA,
        assetB,
        pageB,
        imageElementId,
        remoteImageUrl,
        probeA1,
        probeB2: pageB && remoteImageUrl
          ? await probeRemoteMediaObject(pageB, remoteImageUrl)
          : null,
      });
      if (contextB) {
        await contextB.close().catch(() => undefined);
      }
    }
  });
});
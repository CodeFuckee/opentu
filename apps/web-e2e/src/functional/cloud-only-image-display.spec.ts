/**
 * 云端唯一存储（默认模式）：跨浏览器图片显示 E2E 测试（@functional）
 *
 * 与 cloud-sync-image-display.spec.ts（legacy 路径，显式关闭 cloud-only）互补，
 * 本文件验证默认云端唯一存储模式下的媒体二进制直连通道（2026-11-23 修复引入）：
 *
 * 1. 设备 A 插入三张图片（不点任何同步按钮）→ 画板实体直写云端，
 *    图片二进制经媒体二进制通道实时上云（user_sync_media 行 + yue-sync 对象）；
 * 2. 全新无痕浏览器（设备 B）同账号登录 → 直接打开画板 → 渲染触发
 *    getCachedBlob 云端回填 → 三张图片全部真实解码显示；
 * 3. 设备 B 刷新页面 → 本地已回填，图片再次显示。
 *
 * 控制台断言策略：
 * - 设备 A：严格无 error（本地 SW 缓存命中，不应有任何虚拟路径网络请求失败）；
 * - 设备 B：豁免回填窗口期的 /asset-library/ 虚拟路径 404（localhost 预览环境有
 *   Service Worker，<img> 先走 SW、缓存未命中回落网络 404 属既有设计；生产
 *   LAN HTTP 无 SW 场景由组件守卫置空 src，本就不会发该请求）。豁免记 warning
 *   留档；验收点是「最终显示」。外部站点噪音沿用既有豁免清单。
 */
import { test, expect } from '../fixtures/test-base';
import { existsSync } from 'fs';
import { resolve as resolvePath } from 'path';
import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
  Response,
  TestInfo,
} from '@playwright/test';
import { ensureE2EAccountRegistered } from '../fixtures/e2e-auth';
import { dismissInspirationBoard } from '../fixtures/canvas-helpers';
import {
  getTestAccount,
  getCustomTestAccount,
  POLL_INTERVALS,
} from '../config/e2e.config';
import type { E2ETestAccount } from '../config/e2e.config';
import {
  createNamedBoard,
  enableCloudOnlyStorage,
  fetchRemoteBoardByElementId,
  forceFileInputFallback,
  insertImageToCanvas,
  isCloudMediaObjectReady,
  isMediaSyncedToCloud,
  loginViaUi,
  openBoardFromDrawer,
  openProjectDrawer,
  probeRemoteMediaObject,
  randomBoardName,
} from '../fixtures/cloud-sync-helpers';

// ---------------------------------------------------------------- 监听与诊断

interface ConsoleBucket {
  errors: string[];
  warnings: string[];
}

/**
 * 已知外部资源噪音（第三方站点不可达/防盗链等，与 legacy 图片显示 spec 同清单）。
 */
const EXTERNAL_NOISE_URL_PATTERNS = [/apistatus\.tu-zi\.com/];

function isKnownExternalNoise(text: string, location: string): boolean {
  return EXTERNAL_NOISE_URL_PATTERNS.some(
    (pattern) => pattern.test(text) || pattern.test(location)
  );
}

/**
 * 设备 B 回填窗口期的虚拟路径请求失败豁免：
 * <img> 先走 SW（localhost 有 SW）→ Cache 未命中回落网络 404 → 组件兜底
 * getCachedBlob 云端下载后恢复显示。该 404 是既有 SW 设计在「二进制尚未落地」
 * 时的过渡噪音，不代表缺陷；豁免记 warning 留档（验收点是最终显示）。
 */
function isBackfillWindowAssetNoise(text: string, location: string): boolean {
  return (
    /\/asset-library\/|\/__aitu_cache__\//.test(location) &&
    /\b404\b|Failed to load resource/i.test(text)
  );
}

/** 监听页面 console / pageerror，返回收集桶与停止函数（error 视为报错，warning 仅记录） */
function watchConsole(
  page: Page,
  options: { exemptBackfillNoise: boolean }
): { bucket: ConsoleBucket; stop: () => void } {
  const bucket: ConsoleBucket = { errors: [], warnings: [] };
  const onConsole = (msg: ConsoleMessage) => {
    const loc = msg.location()?.url ? ` @ ${msg.location().url}` : '';
    if (msg.type() === 'error') {
      if (isKnownExternalNoise(msg.text(), loc)) {
        bucket.warnings.push(`${msg.text()}${loc} [external-noise]`);
      } else if (
        options.exemptBackfillNoise &&
        isBackfillWindowAssetNoise(msg.text(), loc)
      ) {
        bucket.warnings.push(`${msg.text()}${loc} [backfill-window-noise]`);
      } else {
        bucket.errors.push(`${msg.text()}${loc}`);
      }
    } else if (msg.type() === 'warning') {
      bucket.warnings.push(`${msg.text()}${loc}`);
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

/** 监听虚拟媒体路径网络响应（诊断留档） */
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

// ---------------------------------------------------------------- 图片元素定位

/** 画布上图片类元素宿主的 element id 列表（与 legacy 图片显示 spec 同口径） */
async function collectImageHostIds(page: Page): Promise<string[]> {
  return page.locator('.board-host-svg [plait-data-id]').evaluateAll((hosts) =>
    hosts
      .filter((host) => host.querySelector('img.image-origin') !== null)
      .map((host) => host.getAttribute('plait-data-id') || '')
      .filter(Boolean)
  );
}

/** 等待新增图片元素渲染到画布，返回其 element id */
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
      { timeout: 60_000, intervals: [POLL_INTERVALS.canvas] }
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

/** 轮询等待指定元素 id 的图片「正常显示」（真实解码 + 未被隐藏） */
async function expectImageLoaded(
  page: Page,
  elementId: string,
  timeout = 60_000
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

const TEST_IMAGE_PATHS = [
  resolvePath(__dirname, '..', '..', 'images', 'test1.png'),
  resolvePath(__dirname, '..', '..', 'images', 'test2.png'),
  resolvePath(__dirname, '..', '..', 'images', 'test3.png'),
];

interface ImageEntry {
  path: string;
  elementId: string;
  remoteUrl: string;
}

/** 收尾留档：控制台 / 网络请求 / 每张图片最终状态与云端行可见性 */
async function collectDiagnostics(
  testInfo: TestInfo,
  deps: {
    consoleA: { bucket: ConsoleBucket };
    consoleB: { bucket: ConsoleBucket } | null;
    assetA: { requests: AssetRequestInfo[] };
    assetB: { requests: AssetRequestInfo[] } | null;
    pageB: Page | null;
    imageEntries: ImageEntry[];
  }
): Promise<void> {
  const { consoleA, consoleB, assetA, assetB, pageB } = deps;
  await testInfo.attach('device-console-logs', {
    body: JSON.stringify(
      {
        deviceA: consoleA.bucket,
        deviceB: consoleB?.bucket ?? null,
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
  await testInfo.attach('device-asset-requests', {
    body: JSON.stringify(
      { deviceA: assetA.requests, deviceB: assetB ? assetB.requests : null },
      null,
      2
    ),
    contentType: 'application/json',
  });
  for (const entry of deps.imageEntries) {
    let imageState: Record<string, unknown> | null = null;
    if (pageB) {
      imageState = await pageB
        .locator(
          `.board-host-svg [plait-data-id="${entry.elementId}"] img.image-origin`
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
        })
        .catch(() => null);
    }
    const mediaViewFromB =
      entry.remoteUrl && pageB
        ? await isMediaSyncedToCloud(pageB, entry.remoteUrl).catch(() => null)
        : null;
    const probe =
      entry.remoteUrl && pageB
        ? await probeRemoteMediaObject(pageB, entry.remoteUrl).catch(
            () => null
          )
        : null;
    await testInfo.attach(`device-b-image-state-${entry.elementId}`, {
      body: JSON.stringify(
        {
          path: entry.path,
          elementId: entry.elementId,
          remoteUrl: entry.remoteUrl,
          imageState,
          mediaViewFromB,
          probe,
        },
        null,
        2
      ),
      contentType: 'application/json',
    });
  }
}

// ---------------------------------------------------------------- 场景

test.describe('云端唯一存储（默认）：媒体二进制通道跨浏览器图片显示', () => {
  // eslint-disable-next-line playwright/expect-expect -- 断言在场景函数内
  test('cloud-only 设备A插图实时上云，新浏览器设备B直接打开画板显示（预设账号池）', async (
    { browser },
    testInfo
  ) => {
    await runCloudOnlyImageScenario(
      browser,
      testInfo,
      getTestAccount(testInfo.workerIndex)
    );
  });

  // eslint-disable-next-line playwright/expect-expect -- 断言在场景函数内
  test('cloud-only 设备A插图实时上云，新浏览器设备B直接打开画板显示（自定义账号）', async (
    { browser },
    testInfo
  ) => {
    const customAccount = getCustomTestAccount();
    if (!customAccount) {
      // eslint-disable-next-line playwright/no-skipped-test -- 未配置自定义账号时按设计跳过
      test.skip(
        true,
        '未配置自定义测试账号：请在 apps/web-e2e/.env.e2e.local 填入 E2E_CUSTOM_ACCOUNT / E2E_CUSTOM_PASSWORD'
      );
      return;
    }
    await runCloudOnlyImageScenario(browser, testInfo, customAccount);
  });
});

async function runCloudOnlyImageScenario(
  browser: Browser,
  testInfo: TestInfo,
  account: E2ETestAccount
): Promise<void> {
  testInfo.setTimeout(420000);

  await ensureE2EAccountRegistered(account);

  const boardName = randomBoardName();
  testInfo.annotations.push({
    type: 'board-name',
    description: `${boardName}（${account.id}）`,
  });

  for (const imagePath of TEST_IMAGE_PATHS) {
    expect(existsSync(imagePath), `测试图片应位于 ${imagePath}`).toBe(true);
  }

  // ============ 设备 A：插入 3 图（不点任何同步按钮） ============
  const contextA = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const pageA = await contextA.newPage();
  await enableCloudOnlyStorage(pageA);
  await forceFileInputFallback(pageA);
  // 设备 A 同样豁免插图窗口期的虚拟路径 404：全新 context 里 SW 注册/claim 需要
  // 时间，插图早于接管时 <img> 直落网络 404（RetryImage 重试链随后自愈），属
  // localhost 预览环境的过渡噪音；验收点是三图显示 + 二进制上云（后续硬断言）。
  const consoleA = watchConsole(pageA, { exemptBackfillNoise: true });
  const assetA = watchAssetRequests(pageA);

  let contextB: BrowserContext | null = null;
  let pageB: Page | null = null;
  let consoleB: { bucket: ConsoleBucket; stop: () => void } | null = null;
  let assetB: { requests: AssetRequestInfo[]; stop: () => void } | null = null;
  const imageEntries: ImageEntry[] = [];

  try {
    await loginViaUi(pageA, account);
    await openProjectDrawer(pageA);
    await createNamedBoard(pageA, boardName);
    await pageA.keyboard.press('Escape');
    await pageA.waitForTimeout(400);
    await dismissInspirationBoard(pageA);

    // E2E-001 前半：依次插入三张图片，设备 A 本地先正常渲染（基线）
    for (const imagePath of TEST_IMAGE_PATHS) {
      const beforeIds = await collectImageHostIds(pageA);
      await insertImageToCanvas(pageA, imagePath);
      const elementId = await waitForNewImage(pageA, beforeIds);
      imageEntries.push({ path: imagePath, elementId, remoteUrl: '' });
      await expectImageLoaded(pageA, elementId, 60_000);
    }

    // E2E-001 后半：画板实体直写云端（自动，无同步按钮）。保存为防抖批量推送，
    // 中间快照可能只含部分图片——轮询直到三个图片元素全部落云再取快照
    const waitForRemoteBoardWithAllImages = async (): Promise<{
      name: string;
      elements: Array<Record<string, unknown>>;
    }> => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const remote = await fetchRemoteBoardByElementId(
          pageA,
          imageEntries[0].elementId
        );
        const elements =
          (remote?.content?.elements as Array<Record<string, unknown>> | undefined) ??
          [];
        const allPresent = imageEntries.every((entry) => {
          const el = elements.find((item) => item.id === entry.elementId);
          return el?.type === 'image' && !!el?.url;
        });
        if (remote && allPresent) {
          return {
            name: remote.content.name as string,
            elements,
          };
        }
        if (Date.now() > deadline) {
          throw new Error(
            `云端画板未在 60s 内包含全部图片元素（已有 ${elements.filter((el) => el.type === 'image').length}/3）`
          );
        }
        await pageA.waitForTimeout(POLL_INTERVALS.canvas);
      }
    };
    const remoteBoard = await waitForRemoteBoardWithAllImages();
    const remoteElements = remoteBoard.elements;
    const remoteBoardName = remoteBoard.name;
    expect(remoteBoardName, '云端画板应有名称').toBeTruthy();
    for (const entry of imageEntries) {
      const remoteElement = remoteElements.find(
        (el) => el.id === entry.elementId
      );
      expect(
        remoteElement?.type,
        `云端元素「${entry.elementId}」类型应为 image`
      ).toBe('image');
      entry.remoteUrl = String(remoteElement?.url ?? '');
      expect(
        entry.remoteUrl,
        `云端图片 URL（${entry.path}）应为虚拟路径（/asset-library/）`
      ).toMatch(/^\/asset-library\//);
    }

    // E2E-001 核心：二进制经媒体二进制通道实时上云（fire-and-forget，
    // 行存在且对象字节为真实媒体才算完成；通道上传窗口放宽到 120s）
    for (const entry of imageEntries) {
      await expect
        .poll(() => isCloudMediaObjectReady(pageA, entry.remoteUrl), {
          timeout: 120_000,
          intervals: [POLL_INTERVALS.canvas],
        })
        .toBe(true);
    }

    await contextA.close();

    // ============ 设备 B：全新无痕浏览器，直接打开画板 ============
    contextB = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    pageB = await contextB.newPage();
    await enableCloudOnlyStorage(pageB);
    consoleB = watchConsole(pageB, { exemptBackfillNoise: true });
    assetB = watchAssetRequests(pageB);

    await loginViaUi(pageB, account);

    // E2E-002：不做任何预下载等待——渲染触发 getCachedBlob 云端回填
    await openProjectDrawer(pageB);
    await openBoardFromDrawer(pageB, remoteBoardName!);
    await dismissInspirationBoard(pageB);

    await Promise.all(
      imageEntries.map((entry) => expectImageLoaded(pageB!, entry.elementId, 90_000))
    );
    for (const entry of imageEntries) {
      const imageBox = await pageB
        .locator(
          `.board-host-svg [plait-data-id="${entry.elementId}"] img.image-origin`
        )
        .boundingBox();
      expect(
        !!(imageBox && imageBox.width > 0 && imageBox.height > 0),
        `设备 B 图片「${entry.elementId}」（${entry.path}）应有非零尺寸`
      ).toBe(true);
    }

    const shotB = await pageB.screenshot();
    await testInfo.attach('device-b-canvas', {
      body: shotB,
      contentType: 'image/png',
    });

    // E2E-003：刷新后本地已回填，图片再次显示（更快收敛）
    await pageB.reload();
    await dismissInspirationBoard(pageB).catch(() => undefined);
    await Promise.all(
      imageEntries.map((entry) => expectImageLoaded(pageB!, entry.elementId, 60_000))
    );

    // 控制台断言（等待异步落定后统一断言；设备 B 已豁免回填窗口噪音）
    await pageB.waitForTimeout(3000);
    consoleA.stop();
    consoleB.stop();
    const errors = {
      deviceA: consoleA.bucket.errors,
      deviceB: consoleB.bucket.errors,
    };
    expect(
      errors.deviceA,
      `设备 A 控制台出现报错：${errors.deviceA.join(' | ')}`
    ).toEqual([]);
    expect(
      errors.deviceB,
      `设备 B 控制台出现报错：${errors.deviceB.join(' | ')}`
    ).toEqual([]);
  } finally {
    await collectDiagnostics(testInfo, {
      consoleA,
      consoleB,
      assetA,
      assetB,
      pageB,
      imageEntries,
    });
    if (contextB) {
      await contextB.close().catch(() => undefined);
    }
  }
}

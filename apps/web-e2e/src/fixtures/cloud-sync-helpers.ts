/**
 * 云端同步 E2E 共享辅助函数
 *
 * 供云端同步相关 spec 复用（云同步状态机一致）：
 * - 双设备（独立 browserContext）真实 UI 登录统一配置的固定测试账号
 * - 画板创建 / 图片插入 / 同步操作（立即同步 / 上传本地 / 下载远程）
 * - 云端数据库（user_sync_data）校验：画板记录与画布元素分类
 *
 * 关键点：
 * 1. 两个独立 browserContext（无痕/incognito）模拟两台设备，本地存储互不共享；
 * 2. 测试账号与密码来自统一配置 src/config/e2e.config.ts（固定账号池，不新建用户）；
 * 3. 插入图片用 addImage（browser-fs-access 的 showOpenFilePicker）：
 *    通过 addInitScript 禁用 showOpenFilePicker 强制回退 <input type=file>，
 *    再用 filechooser/setInputFiles 提供本地测试图片；
 * 4. 数据库验证：用页面登录态 access_token 走 Supabase REST 查询 user_sync_data，
 *    确认画板记录与元素内容已写入云端（RLS 允许用户查询自己的数据）。
 */
import { expect, type Page } from '@playwright/test';
import {
  E2E_TEST_PASSWORD,
  SUPABASE,
  TIMEOUTS,
  POLL_INTERVALS,
} from '../config/e2e.config';
import type { E2ETestAccount } from '../config/e2e.config';
import { clickToolRadio } from './canvas-helpers';

/** 生成 16 位随机数（画板名称） */
export function randomBoardName(): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** 强制 browser-fs-access 回退到 <input type=file>（Playwright 可拦截 filechooser） */
export async function forceFileInputFallback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // 彻底删除原生 File System Access API，使 browser-fs-access 回退到 hidden input
    // （仅设为 undefined 不够：'showOpenFilePicker' in window 仍为 true，会走 FSA）
    try {
      // @ts-expect-error - File System Access API 非标准类型，删除走 browser-fs-access 回退
      delete window.showOpenFilePicker;
    } catch {
      // 某些浏览器该属性不可删除，改为覆盖为 undefined
      const w = window as unknown as Record<string, unknown>;
      w.showOpenFilePicker = undefined;
    }
    // 禁用 input.showPicker()：Chromium 中 browser-fs-access 回退路径优先调用
    // showPicker()（依赖用户手势，历史调用后可能失效），强制走 input.click()
    // 以保证每次插入图片都能触发 Playwright 的 filechooser 事件
    try {
      delete HTMLInputElement.prototype.showPicker;
    } catch {
      const proto = HTMLInputElement.prototype as unknown as Record<
        string,
        unknown
      >;
      proto.showPicker = undefined;
    }
  });
}

/**
 * 通过真实 UI 登录测试账号（可传账号 id 字符串或完整 E2ETestAccount）。
 * 密码优先使用账号自带的 password（自定义账号），否则回退 E2E_TEST_PASSWORD。
 * 与 auth.setup 一致；若已持有会话（storageState）则跳过。
 */
export async function loginViaUi(
  page: Page,
  account: string | E2ETestAccount
): Promise<void> {
  const accountId = typeof account === 'string' ? account : account.id;
  const password =
    typeof account === 'string'
      ? E2E_TEST_PASSWORD
      : account.password ?? E2E_TEST_PASSWORD;
  await page.goto('/');
  // 可能已带 storageState 登录会话：等待「登录门禁」或「工作区」任一出现
  const gate = page.locator('[data-testid="auth-gate"]');
  const workspace = page.locator('.drawnix');
  await expect(gate.or(workspace).first()).toBeVisible({
    timeout: TIMEOUTS.authGate,
  });
  if (await gate.isVisible().catch(() => false)) {
    await page.getByPlaceholder('oa账号（小写）').fill(accountId);
    await page.getByPlaceholder('密码（至少 6 位）').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(workspace).toBeVisible({ timeout: TIMEOUTS.authGate });
  }
  // 等待工作区/工具栏完全就绪
  await expect(page.getByTestId('unified-toolbar')).toBeVisible({
    timeout: TIMEOUTS.toolbar,
  });
  await page.waitForTimeout(2500);
}

/** 打开项目抽屉（画布管理页签）；已打开则直接返回 */
export async function openProjectDrawer(page: Page): Promise<void> {
  const drawer = page.getByTestId('project-drawer');
  if (await drawer.isVisible().catch(() => false)) {
    return;
  }
  const projectBtn = page.getByTestId('toolbar-project');
  await expect(projectBtn).toBeVisible({ timeout: TIMEOUTS.drawer });
  // 先清理可能残留的弹层/焦点，再点击；失败重试一次
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(TIMEOUTS.pause);
  await projectBtn.click({ force: true });
  try {
    await expect(drawer).toBeVisible({ timeout: TIMEOUTS.drawer });
  } catch {
    await projectBtn.click({ force: true });
    await expect(drawer).toBeVisible({ timeout: TIMEOUTS.drawer });
  }
}

/** 点击「新建画板」并重命名 */
export async function createNamedBoard(
  page: Page,
  name: string
): Promise<void> {
  const drawer = page.getByTestId('project-drawer');
  await drawer.getByRole('button', { name: '新建画板' }).click();
  // 新建后自动进入就地重命名态：节点内的 Input 自动聚焦
  // （注意：优先匹配画板节点内正在编辑的 input，避免匹配搜索框）
  const renameInput = drawer.locator('.project-drawer-node input').first();
  await expect(renameInput).toBeVisible({ timeout: TIMEOUTS.toolCheck });
  await renameInput.fill(name);
  await renameInput.press('Enter');
  await page.waitForTimeout(TIMEOUTS.pause);
  // 确认画板出现在列表中
  await expect(drawer.getByText(name, { exact: true }).first()).toBeVisible({
    timeout: TIMEOUTS.toolCheck,
  });
}

/** 通过工具栏的图片工具插入一张图片（可重复调用） */
export async function insertImageToCanvas(
  page: Page,
  imagePath: string
): Promise<void> {
  // 图片工具渲染为 radio（creation-toolbar，key='image'，点击后触发 addImage）
  const imageRadio = page.getByRole('radio', { name: /图片/ }).first();
  await expect(imageRadio).toBeVisible({ timeout: TIMEOUTS.drawer });

  // 清除画布选中态（选中元素时弹出工具栏可能干扰后续点击/手势链）
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);

  // 若图片工具已处于选中态（同页面重复插入），再次点击选中中的 radio 不会触发
  // filechooser —— 先切回「选择」工具，让图片 radio 重新触发 addImage
  if (await imageRadio.isChecked().catch(() => false)) {
    const selectionRadio = page.getByRole('radio', { name: /选择/ }).first();
    await clickToolRadio(page, selectionRadio);
    await page.waitForTimeout(TIMEOUTS.pause);
  }

  // 监听 filechooser：addImage 会用隐藏 input 打开文件选择
  // 注意：TDesign radio 需点击 label（input 的直接父级）；不 force，让事件正常派发
  const radioLabel = imageRadio.locator('xpath=..');
  await radioLabel.scrollIntoViewIfNeeded();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: TIMEOUTS.element }),
    radioLabel.click(),
  ]);
  await chooser.setFiles(imagePath);

  // 等待图片元素渲染到画布（.element-host 中出现 plait-data-id 元素）
  await expect
    .poll(
      () =>
        page.locator('.board-host-svg .element-host [plait-data-id]').count(),
      { timeout: TIMEOUTS.element, intervals: [POLL_INTERVALS.canvas] }
    )
    .toBeGreaterThan(0);
}

/** 打开云端同步设置面板 */
export async function openCloudSyncSettings(page: Page): Promise<void> {
  // 打开 App 菜单
  const menuBtn = page.locator(
    '.unified-toolbar [data-track="toolbar_click_menu"]'
  );
  await expect(menuBtn).toBeVisible({ timeout: TIMEOUTS.drawer });
  await menuBtn.click({ force: true });
  // 点「云端同步」菜单项
  const cloudSyncItem = page.locator(
    '[data-track="toolbar_click_menu_cloud_sync"]'
  );
  await expect(cloudSyncItem).toBeVisible({ timeout: TIMEOUTS.toolCheck });
  await cloudSyncItem.click();

  const dialog = page.locator('.sync-settings-dialog');
  await expect(dialog).toBeVisible({ timeout: TIMEOUTS.confirmDialog });
}

/** 点击指定同步操作按钮（立即同步 / 下载远程 / 上传本地）并等待完成 */
export async function clickSyncAction(
  page: Page,
  buttonName: string
): Promise<void> {
  const dialog = page.locator('.sync-settings-dialog');
  const actionBtn = dialog.getByRole('button', {
    name: new RegExp(buttonName),
  });
  // 登录后的自动同步进行中时操作按钮不渲染（显示"同步正在进行中"）——
  // 这是合法状态：放宽到 30s 等自动同步结束、按钮回归，避免时序 flake
  await expect(actionBtn).toBeVisible({ timeout: 30_000 });
  await actionBtn.click();

  // 「上传本地」「下载远程」会弹出确认对话框（「确认上传覆盖」/「确认下载覆盖」），
  // 需要点「继续上传」/「继续下载」确认；「立即同步」无确认框
  const confirmBtn = page.getByRole('button', {
    name: buttonName === '上传本地' ? /继续上传/ : /继续下载/,
  });
  // 确认框可能有渲染延迟：可见性短轮询（isVisible 立即返回会漏掉慢一帧的弹窗）
  const confirmVisible = await confirmBtn
    .waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (confirmVisible) {
    await confirmBtn.click();
  }

  // 等待同步中状态结束：动作按钮重新可用（文本恢复，非「同步中...」）
  await expect(actionBtn).toBeEnabled({ timeout: TIMEOUTS.syncAction });
  await page.waitForTimeout(1500);
}

/** 关闭云端同步设置面板（显式关闭按钮优先；等待弹窗与遮罩完全消失） */
export async function closeSyncSettingsDialog(page: Page): Promise<void> {
  const dialog = page.locator('.sync-settings-dialog');
  if (!(await dialog.isVisible().catch(() => false))) {
    return;
  }
  // 优先点击 TDesign Dialog 的显式关闭按钮（Escape 关闭依赖焦点，非总可靠）
  const closeBtn = dialog
    .locator(
      '.t-dialog__close, .t-dialog__header-close, button[aria-label="关闭"]'
    )
    .first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click({ force: true });
  } else {
    await page.keyboard.press('Escape').catch(() => undefined);
  }
  // 等待弹窗与 mask 完全消失，避免残留遮罩拦截后续工具栏点击
  await expect(dialog).toBeHidden({ timeout: TIMEOUTS.confirmDialog });
  await page.waitForTimeout(TIMEOUTS.dialogClosePause);
}

/**
 * 设备 B 侧同步并打开画板：立即同步 → 关闭弹窗 → 项目抽屉中点击画板。
 * 下载-刷新链路的时序抖动（画板偶尔未随列表刷新）时自动重试一次同步。
 */
export async function syncAndOpenBoard(
  page: Page,
  boardName: string
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await openCloudSyncSettings(page);
    await clickSyncNow(page);
    await closeSyncSettingsDialog(page);

    await openProjectDrawer(page);
    const drawer = page.getByTestId('project-drawer');
    const boardItem = drawer.getByText(boardName, { exact: true }).first();
    if (await boardItem.isVisible().catch(() => false)) {
      await boardItem.click();
      await page.waitForTimeout(TIMEOUTS.boardOpenPause);
      return;
    }
    if (attempt === 0) {
      // 第一轮未出现：关闭抽屉重试一轮完整同步
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(400);
    }
  }
  throw new Error(
    `设备同步后画板「${boardName}」未出现在项目抽屉（重试后仍不可见）`
  );
}

/**
 * 仅打开项目抽屉中的画板（不触达同步）。
 * 供「先等媒体字节落地、再打开画板」的流程使用：打开画板前若图片二进制尚未
 * 就绪，<img> 请求虚拟 URL 会产生 SW 404 控制台噪音且显示竞态。
 */
export async function openBoardFromDrawer(
  page: Page,
  boardName: string
): Promise<void> {
  await openProjectDrawer(page);
  const drawer = page.getByTestId('project-drawer');
  const boardItem = drawer.getByText(boardName, { exact: true }).first();
  await expect(boardItem).toBeVisible({ timeout: TIMEOUTS.boardInDrawer });
  await boardItem.click();
  await page.waitForTimeout(TIMEOUTS.boardOpenPause);
}

/** 点击「立即同步」并等待完成 */
export async function clickSyncNow(page: Page): Promise<void> {
  await clickSyncAction(page, '立即同步');
}

/** 统计项目抽屉画布管理列表中的画板数量 */
export async function countBoardsInDrawer(page: Page): Promise<number> {
  const drawer = page.getByTestId('project-drawer');
  await expect(drawer).toBeVisible({ timeout: TIMEOUTS.drawer });
  const rows = drawer.locator('.project-drawer-node__row');
  // 等待画板行渲染（下载后可能异步更新）
  await expect
    .poll(() => rows.count(), { timeout: TIMEOUTS.toolbar })
    .toBeGreaterThan(0);
  const totalRows = await rows.count();
  const folderRows = await drawer
    .locator('.project-drawer-node__row--folder')
    .count();
  return totalRows - folderRows;
}

/** 从页面 localStorage 提取 Supabase access_token */
async function getAccessToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        if (!key.startsWith('sb-') || !key.endsWith('-auth-token')) {
          continue;
        }
        const raw = localStorage.getItem(key) || '';
        const parsed = JSON.parse(raw);
        const token =
          parsed?.currentSession?.access_token || parsed?.access_token || '';
        if (token) {
          return token;
        }
      }
    } catch {
      // 解析失败则 token 为空
    }
    return '';
  });
}

/** 拉取云端全部画板（board）记录（按 updated_at 倒序）；失败或无登录态时返回空数组 */
async function fetchBoardRows(
  page: Page
): Promise<Array<Record<string, unknown>>> {
  const accessToken = await getAccessToken(page);
  if (!accessToken) {
    return [];
  }
  // REST 默认 1000 行静默截断：limit/offset 显式分页拉全
  // （注意不能用 range= 查询参数：会被 PostgREST 当作不存在的列过滤器 400）
  const PAGE_SIZE = 500;
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await fetch(
      `${SUPABASE.url}/rest/v1/user_sync_data?select=entity_type,entity_id,content,checksum&entity_type=eq.board&order=updated_at.desc&limit=${PAGE_SIZE}&offset=${offset}`,
      {
        headers: {
          apikey: SUPABASE.anonKey,
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    if (!res.ok) {
      console.warn(
        `[cloud-sync-helpers] 拉取 board 记录失败: HTTP ${res.status} (offset=${offset})`
      );
      return offset === 0 ? [] : rows;
    }
    const batch = (await res.json()) as Array<Record<string, unknown>>;
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) {
      break;
    }
  }
  return rows;
}

/** 通过 Supabase REST 验证云端 user_sync_data 中存在画板记录 */
export async function verifyBoardInSupabase(
  page: Page,
  boardName: string
): Promise<{ found: boolean; rows: unknown[] }> {
  const rows = await fetchBoardRows(page);
  const found = rows.some((row) => {
    const content = row.content as Record<string, unknown> | null;
    return content?.name === boardName;
  });
  return { found, rows };
}

/** 画布元素分类：图片 / 文本 / 几何形状 / 自由画笔迹 */
export interface BoardElementClassification {
  total: number;
  images: Array<Record<string, unknown>>;
  texts: Array<Record<string, unknown>>;
  shapes: Array<Record<string, unknown>>;
  freehands: Array<Record<string, unknown>>;
}

/** 按 Plait 元素特征分类（与 drawnix 真实元素结构一致） */
export function classifyBoardElements(
  elements: unknown[] | undefined
): BoardElementClassification {
  const classification: BoardElementClassification = {
    total: elements?.length ?? 0,
    images: [],
    texts: [],
    shapes: [],
    freehands: [],
  };
  for (const raw of elements ?? []) {
    const el = raw as Record<string, unknown>;
    if (!el || typeof el !== 'object') {
      continue;
    }
    if (el.type === 'image' || typeof el.url === 'string') {
      classification.images.push(el);
    } else if (el.type === 'freehand') {
      classification.freehands.push(el);
    } else if (el.shape === 'text') {
      classification.texts.push(el);
    } else if (
      el.type === 'geometry' ||
      (el.shape && typeof el.shape === 'string')
    ) {
      classification.shapes.push(el);
    }
  }
  return classification;
}

/**
 * 通过 Supabase REST 拉取指定画板的云端 content（含全部画布元素）。
 * 返回 null 表示未找到（画板未同步或查询失败）。
 */
export async function fetchRemoteBoardContent(
  page: Page,
  boardName: string
): Promise<{
  content: Record<string, unknown>;
  row: Record<string, unknown>;
} | null> {
  const rows = await fetchBoardRows(page);
  for (const row of rows) {
    const content = row.content as Record<string, unknown> | null;
    if (content?.name === boardName) {
      return { content, row };
    }
  }
  return null;
}

/**
 * 通过 Supabase REST 按「画布元素 id」定位云端画板。
 * 元素 id（plait-data-id）跨云端同步保持不变，可精确找到插入图片所在画板。
 * 返回 null 表示未找到（画板未同步或查询失败）。
 */
export async function fetchRemoteBoardByElementId(
  page: Page,
  elementId: string
): Promise<{
  content: Record<string, unknown>;
  row: Record<string, unknown>;
} | null> {
  const rows = await fetchBoardRows(page);
  for (const row of rows) {
    const content = row.content as Record<string, unknown> | null;
    if (!content) {
      continue;
    }
    const elements = content.elements as
      | Array<Record<string, unknown>>
      | undefined;
    if (
      Array.isArray(elements) &&
      elements.some((el) => (el as Record<string, unknown>)?.id === elementId)
    ) {
      return { content, row };
    }
  }
  return null;
}

/**
 * 指定媒体 URL 是否已同步到云端（user_sync_media 元数据存在，即二进制已上传完成）。
 * 返回 null 表示未登录或查询失败；布尔值为查询结果。
 */
export async function isMediaSyncedToCloud(
  page: Page,
  mediaUrl: string
): Promise<boolean | null> {
  const accessToken = await getAccessToken(page);
  if (!accessToken) {
    return null;
  }
  const res = await fetch(
    `${
      SUPABASE.url
    }/rest/v1/user_sync_media?select=url&url=eq.${encodeURIComponent(
      mediaUrl
    )}`,
    {
      headers: {
        apikey: SUPABASE.anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
  if (!res.ok) {
    return null;
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows.length > 0;
}

/**
 * 探测云端 media 行与其 storage 对象是否真实可下载（模拟 media-sync 下载路径）。
 * 返回 rowFound（元数据行是否存在）、下载 HTTP 状态（200 = 可下载）与
 * isMediaContent（对象内容是否为真实媒体，非 HTML 兜底页等毒化字节）。
 * 用于区分「行存在但对象被外部删除/缺失/毒化」与「本机下载逻辑失败」。
 */
export async function probeRemoteMediaObject(
  page: Page,
  mediaUrl: string
): Promise<{
  rowFound: boolean;
  status: number | null;
  isMediaContent: boolean | null;
}> {
  const accessToken = await getAccessToken(page);
  if (!accessToken) {
    return { rowFound: false, status: null, isMediaContent: null };
  }
  const res = await fetch(
    `${
      SUPABASE.url
    }/rest/v1/user_sync_media?select=storage_path&url=eq.${encodeURIComponent(
      mediaUrl
    )}`,
    {
      headers: {
        apikey: SUPABASE.anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
  if (!res.ok) {
    return { rowFound: false, status: null, isMediaContent: null };
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    // 查询成功但 0 行 = 元数据行不存在（媒体尚未同步），语义应为 rowFound: false
    return { rowFound: false, status: null, isMediaContent: null };
  }
  const storagePath = String(rows[0].storage_path ?? '');
  if (!storagePath) {
    return { rowFound: true, status: null, isMediaContent: null };
  }
  const encoded = storagePath.split('/').map(encodeURIComponent).join('/');
  const dl = await fetch(
    `${SUPABASE.url}/storage/v1/object/yue-sync/${encoded}`,
    {
      headers: {
        apikey: SUPABASE.anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
  // 内容核验：头部字节不能是 HTML 文档（与 isLikelyMediaBlob 同一判断口径，
  // 防止历史版本上传的 200 HTML 兜底页被误认为「图片已上传成功」）
  let isMediaContent: boolean | null = null;
  if (dl.ok) {
    try {
      const head = new Uint8Array(await dl.clone().arrayBuffer()).slice(0, 512);
      const text = new TextDecoder().decode(head).trimStart();
      isMediaContent =
        !/^<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text);
    } catch {
      isMediaContent = null;
    }
  }
  return { rowFound: true, status: dl.status, isMediaContent };
}

/**
 * 上传侧字节就绪核验：目标 URL 的云端对象是否已是真实媒体（非 HTML 兜底页）。
 * 行的存在 ≠ 字节正确：历史版本可能把 HTML 当图片上传（毒化行），设备 A 需要
 * 在本次同步中自愈重传（media-sync 按 storage_path 哈希不匹配触发），只有对象
 * 内容为媒体才算「上传完成」，否则提前关闭设备 A 会中断 fire-and-forget 的自愈。
 */
export async function isCloudMediaObjectReady(
  page: Page,
  mediaUrl: string
): Promise<boolean> {
  const probe = await probeRemoteMediaObject(page, mediaUrl);
  return (
    probe.rowFound && probe.status === 200 && probe.isMediaContent === true
  );
}

/** 从 Slate 段落结构中提取纯文本 */
export function extractSlateText(text: unknown): string {
  if (!text || typeof text !== 'object') {
    return '';
  }
  const t = text as { children?: unknown[]; text?: string };
  if (typeof t.text === 'string') {
    return t.text;
  }
  return (t.children ?? []).map(extractSlateText).join('');
}

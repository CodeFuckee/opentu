/**
 * 画布素材云端同步数据完整性测试
 *
 * 核心问题：云端同步后，画布中的图片、文字、绘制的形状、自由画笔迹等素材
 * 能否「原样」同步过去 —— 不丢失、不截断、不改字段。
 *
 * 覆盖的同步链路（与生产一致）：
 * 1. 上传侧：本地画板（含四类素材元素）→ toSyncEntities → JSON 云端存储往返 → 素材无损
 * 2. checksum：素材内容变化（改文字/换图片/移动形状/新增元素）必须被增量同步感知
 * 3. 冲突合并：双端画板各自新增素材 → mergeBoardElements 合并后四类素材齐全
 * 4. 下载侧：applyRemoteEntities 把云端画板（含四类素材）完整写回本地存储
 * 5. 引擎闭环：runSync 全量上传 / 跨设备下载均保持素材数据一致
 * 6. 媒体同步：画布图片 URL 的二进制进入媒体同步上传管线
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- 素材构造（与 Plait 真实元素结构一致） ----------

export interface MaterialBoard {
  id: string;
  name: string;
  folderId: string | null;
  order: number;
  createdAt: number;
  updatedAt: number;
  elements: unknown[];
}

/** 图片元素：type='image' + 虚拟路径 url（对应设备 A 插入的本地图片） */
function imageElement() {
  return {
    id: 'mat-img-1',
    type: 'image',
    url: '/asset-library/content-abc123.png',
    points: [
      [100, 120],
      [340, 280],
    ],
    angle: 0,
    width: 240,
    height: 160,
  };
}

/** 文本元素：shape='text' + Slate 段落（对应设备 A 输入的文字） */
function textElement(content = '云端同步的文字素材 E2E') {
  return {
    id: 'mat-text-1',
    type: 'geometry',
    shape: 'text',
    points: [
      [0, 0],
      [260, 60],
    ],
    text: { children: [{ text: content }] },
    autoSize: true,
  };
}

/** 矩形形状元素：shape='rectangle'（对应设备 A 绘制的形状） */
function rectangleElement() {
  return {
    id: 'mat-rect-1',
    type: 'geometry',
    shape: 'rectangle',
    points: [
      [-90, -50],
      [90, 50],
    ],
    fill: '#F39C12',
    strokeColor: '#333333',
    strokeWidth: 2,
    angle: 0,
  };
}

/** 自由画笔迹元素：type='freehand' + 压力点（对应设备 A 手绘笔迹） */
function freehandElement() {
  return {
    id: 'mat-pen-1',
    type: 'freehand',
    shape: 'feltTipPen',
    points: [
      [0, 0],
      [12, 18],
      [30, 22],
      [55, 18],
      [80, 30],
    ],
    pressures: [0.4, 0.8, 1, 0.6, 0.9],
    strokeWidth: 4,
    strokeColor: '#E91E63',
  };
}

/** 构造包含四类素材的画板（元素可覆写/追加） */
function createMaterialBoard(
  overrides: { elements?: unknown[]; updatedAt?: number } = {}
): MaterialBoard {
  return {
    id: 'board-mat-1',
    name: '素材同步测试画板',
    folderId: null,
    order: 0,
    createdAt: 1000,
    updatedAt: overrides.updatedAt ?? 2000,
    elements: overrides.elements ?? [
      imageElement(),
      textElement(),
      rectangleElement(),
      freehandElement(),
    ],
  };
}

/** 按 id 索引元素 */
function indexById(elements: unknown[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const el of elements) {
    const e = el as { id?: string };
    if (e?.id) {
      map.set(e.id, e as Record<string, unknown>);
    }
  }
  return map;
}

/** 模拟云端 JSONB 存储往返（PostgREST 会经过 JSON 序列化） */
function cloudRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** 递归提取 Slate 文本中的全部字符串 */
function extractSlateText(text: unknown): string {
  if (!text || typeof text !== 'object') {
    return '';
  }
  const t = text as { children?: unknown[]; text?: string };
  if (typeof t.text === 'string') {
    return t.text;
  }
  return (t.children ?? []).map(extractSlateText).join('');
}

// ---------- 1. 上传侧：收集 → 序列化 → 云端 JSON 往返 ----------

describe('上传链路：画板素材经序列化与云端 JSON 存储后无损', () => {
  it('四类素材（图片/文字/矩形/笔迹）全部保留且字段完整', async () => {
    const { toSyncEntities } = await import('./collector-core');
    const board = createMaterialBoard();
    const entities = toSyncEntities([
      { entityType: 'board', entityId: board.id, content: board, updatedAt: board.updatedAt },
    ]);
    expect(entities).toHaveLength(1);

    // 云端 JSONB 往返（board content 是 JSONB 列）
    const cloudContent = cloudRoundTrip(
      entities[0].content
    ) as MaterialBoard;
    const elements = cloudContent.elements ?? [];
    expect(elements).toHaveLength(4);

    const byId = indexById(elements);

    // 图片素材：url / points / 尺寸完整
    const img = byId.get('mat-img-1');
    expect(img).toBeDefined();
    expect(img!.type).toBe('image');
    expect(img!.url).toBe('/asset-library/content-abc123.png');
    expect(img!.points).toEqual([
      [100, 120],
      [340, 280],
    ]);
    expect(img!.width).toBe(240);

    // 文字素材：Slate 文本内容一致（含中文）
    const text = byId.get('mat-text-1');
    expect(text).toBeDefined();
    expect(text!.shape).toBe('text');
    expect(extractSlateText(text!.text)).toBe('云端同步的文字素材 E2E');

    // 形状素材：shape / 描边 / 填充 / 位置完整
    const rect = byId.get('mat-rect-1');
    expect(rect).toBeDefined();
    expect(rect!.type).toBe('geometry');
    expect(rect!.shape).toBe('rectangle');
    expect(rect!.fill).toBe('#F39C12');
    expect(rect!.strokeWidth).toBe(2);
    expect(rect!.points).toEqual([
      [-90, -50],
      [90, 50],
    ]);

    // 笔迹素材：shape / 压力点 / 线宽完整
    const pen = byId.get('mat-pen-1');
    expect(pen).toBeDefined();
    expect(pen!.type).toBe('freehand');
    expect(pen!.shape).toBe('feltTipPen');
    expect(pen!.points).toHaveLength(5);
    expect(pen!.pressures).toEqual([0.4, 0.8, 1, 0.6, 0.9]);
    expect(pen!.strokeWidth).toBe(4);
  });

  it('云端往返后元素顺序与数量与本地一致（不丢元素、不重排语义）', async () => {
    const { toSyncEntities } = await import('./collector-core');
    const board = createMaterialBoard();
    const entities = toSyncEntities([
      { entityType: 'board', entityId: board.id, content: board, updatedAt: board.updatedAt },
    ]);
    const cloudContent = cloudRoundTrip(entities[0].content) as MaterialBoard;
    expect((cloudContent.elements ?? []).map((e) => (e as { id: string }).id)).toEqual([
      'mat-img-1',
      'mat-text-1',
      'mat-rect-1',
      'mat-pen-1',
    ]);
  });
});

// ---------- 2. checksum：增量同步能感知素材变化 ----------

describe('checksum：素材内容变化必须被增量同步感知', () => {
  async function checksumOf(board: unknown): Promise<string> {
    const { toSyncEntities } = await import('./collector-core');
    const entities = toSyncEntities([
      { entityType: 'board', entityId: 'board-mat-1', content: board, updatedAt: 2000 },
    ]);
    return entities[0].checksum;
  }

  it('相同素材内容 → checksum 稳定', async () => {
    const a = await checksumOf(createMaterialBoard());
    const b = await checksumOf(createMaterialBoard());
    expect(a).toBe(b);
  });

  it('修改文字内容 → checksum 变化（增量同步会上传新文本）', async () => {
    const before = await checksumOf(createMaterialBoard());
    const changed = createMaterialBoard({
      elements: [
        imageElement(),
        textElement('改过的文字内容'),
        rectangleElement(),
        freehandElement(),
      ],
    });
    expect(await checksumOf(changed)).not.toBe(before);
  });

  it('更换图片 URL → checksum 变化（新图片会被同步）', async () => {
    const before = await checksumOf(createMaterialBoard());
    const changed = createMaterialBoard({
      elements: [
        { ...imageElement(), url: '/asset-library/content-other456.jpg' },
        textElement(),
        rectangleElement(),
        freehandElement(),
      ],
    });
    expect(await checksumOf(changed)).not.toBe(before);
  });

  it('移动形状位置（points 变化）→ checksum 变化', async () => {
    const before = await checksumOf(createMaterialBoard());
    const moved = createMaterialBoard({
      elements: [
        imageElement(),
        textElement(),
        { ...rectangleElement(), points: [[10, 10], [200, 150]] },
        freehandElement(),
      ],
    });
    expect(await checksumOf(moved)).not.toBe(before);
  });

  it('新增一个素材元素 → checksum 变化', async () => {
    const before = await checksumOf(createMaterialBoard());
    const added = createMaterialBoard({
      elements: [
        imageElement(),
        textElement(),
        rectangleElement(),
        freehandElement(),
        { ...rectangleElement(), id: 'mat-rect-2', shape: 'ellipse' },
      ],
    });
    expect(await checksumOf(added)).not.toBe(before);
  });
});

// ---------- 3. 冲突合并：双端素材合并不丢失 ----------

describe('mergeBoardElements：跨设备素材合并', () => {
  function boardOf(elements: unknown[], updatedAt: number) {
    return createMaterialBoard({ elements, updatedAt });
  }

  it('本地图片+文字 与 远程矩形+笔迹 合并 → 四类素材齐全、无冲突', async () => {
    const { mergeBoardElements } = await import('./merge');
    const local = boardOf([imageElement(), textElement()], 2000);
    const remote = boardOf([rectangleElement(), freehandElement()], 1800);
    const result = mergeBoardElements(local, remote);

    expect(result.hasConflicts).toBe(false);
    const ids = (result.mergedBoard.elements as { id: string }[]).map((e) => e.id);
    expect(ids).toContain('mat-img-1');
    expect(ids).toContain('mat-text-1');
    expect(ids).toContain('mat-rect-1');
    expect(ids).toContain('mat-pen-1');
    expect(ids).toHaveLength(4);
    expect(result.mergedBoard.updatedAt).toBe(2000);
  });

  it('同 ID 文本元素双端都编辑过 → 冲突记录且默认取本地，素材仍完整', async () => {
    const { mergeBoardElements } = await import('./merge');
    const local = boardOf(
      [imageElement(), textElement('本地编辑的文字'), rectangleElement()],
      3000
    );
    const remote = boardOf(
      [textElement('远程编辑的文字'), freehandElement()],
      2500
    );
    const result = mergeBoardElements(local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflictingElements.map((c) => c.elementId)).toEqual(['mat-text-1']);

    const byId = indexById(result.mergedBoard.elements as unknown[]);
    // 冲突元素取本地，但其余三方素材（图片/矩形/笔迹）全部保留
    expect(extractSlateText(byId.get('mat-text-1')!.text)).toBe('本地编辑的文字');
    expect(byId.get('mat-img-1')).toBeDefined();
    expect(byId.get('mat-rect-1')).toBeDefined();
    expect(byId.get('mat-pen-1')).toBeDefined();
    expect(result.mergedBoard.elements).toHaveLength(4);
  });

  it('合并结果能再次进入上传链路（序列化闭合）', async () => {
    const { mergeBoardElements } = await import('./merge');
    const { toSyncEntities } = await import('./collector-core');
    const result = mergeBoardElements(
      boardOf([imageElement(), textElement()], 2000),
      boardOf([rectangleElement(), freehandElement()], 1800)
    );
    const entities = toSyncEntities([
      { entityType: 'board', entityId: 'board-mat-1', content: result.mergedBoard, updatedAt: result.mergedBoard.updatedAt },
    ]);
    const cloudContent = cloudRoundTrip(entities[0].content) as MaterialBoard;
    const byId = indexById(cloudContent.elements ?? []);
    for (const key of ['mat-img-1', 'mat-text-1', 'mat-rect-1', 'mat-pen-1']) {
      expect(byId.get(key), `合并后素材 ${key} 应可再次上云`).toBeDefined();
    }
  });
});

// ---------- 4. 下载侧：云端画板素材完整写回本地 ----------

describe('applyRemoteEntities：下载画板素材保真写回本地', () => {
  const mocks = vi.hoisted(() => ({
    reload: vi.fn().mockResolvedValue(undefined),
    saveBoard: vi.fn().mockResolvedValue(undefined),
    saveFolder: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue(undefined),
  }));

  vi.mock('../workspace-service', () => ({
    workspaceService: { reload: mocks.reload },
  }));

  vi.mock('../workspace-storage-service', () => ({
    workspaceStorageService: {
      saveBoard: mocks.saveBoard,
      saveFolder: mocks.saveFolder,
      saveState: mocks.saveState,
      loadState: vi
        .fn()
        .mockResolvedValue({ currentBoardId: null, expandedFolderIds: [] }),
    },
  }));

  vi.mock('../prompt-storage-service', () => ({
    mergePromptHistory: vi.fn(),
    mergeVideoPromptHistory: vi.fn(),
    mergeImagePromptHistory: vi.fn(),
  }));

  beforeEach(() => {
    mocks.reload.mockClear();
    mocks.saveBoard.mockClear();
  });

  it('云端画板（图片/文字/矩形/笔迹）下载后完整写入本地存储', async () => {
    const { applyRemoteEntities } = await import('./apply-remote');
    const board = createMaterialBoard();
    const result = await applyRemoteEntities([
      {
        entity_type: 'board',
        entity_id: board.id,
        content: board,
        checksum: 'sum-1',
        updated_at: board.updatedAt,
        deleted_at: null,
      },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toEqual([]);
    expect(mocks.saveBoard).toHaveBeenCalledTimes(1);
    const saved = mocks.saveBoard.mock.calls[0][0] as MaterialBoard;
    const savedJson = JSON.stringify(saved);
    expect(savedJson.includes('mat-img-1'), `saveBoard 报错检查: ${savedJson.slice(0, 500)}`).toBe(true);
    const byId = indexById(saved.elements);
    expect(byId.size, `saved=${savedJson.slice(0, 800)}`).toBe(4);
    expect((byId.get('mat-img-1')!.url as string).startsWith('/asset-library/')).toBe(true);
    expect(extractSlateText(byId.get('mat-text-1')!.text)).toBe('云端同步的文字素材 E2E');
    expect(byId.get('mat-rect-1')!.shape).toBe('rectangle');
    expect(byId.get('mat-pen-1')!.type).toBe('freehand');
  });
});

// ---------- 5. 引擎闭环：runSync 全量上传 / 跨设备下载 ----------

describe('runSync：画布素材同步闭环', () => {
  function syncEntityOf(board: MaterialBoard) {
    return {
      entity_type: 'board' as const,
      entity_id: board.id,
      content: board,
      checksum: `sum-${board.id}`,
      updated_at: board.updatedAt,
      deleted_at: null,
    };
  }

  it('设备 A 首次同步：含四类素材的画板被完整上传（内容与本地一致）', async () => {
    const { runSync } = await import('./sync-engine');
    const board = createMaterialBoard();
    const localEntity = syncEntityOf(board);

    const upsertRemote = vi.fn().mockResolvedValue({ data: null, error: null });
    const result = await runSync({
      client: {},
      user: { id: 'u1', email: 'e@example.com' },
      lastSyncTime: null,
      collectLocal: vi.fn().mockResolvedValue({
        entities: [localEntity],
        stats: { total: 1 },
      }),
      fetchRemote: vi.fn().mockResolvedValue([]),
      upsertRemote,
      softDeleteRemote: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(1);
    expect(upsertRemote).toHaveBeenCalledTimes(1);
    const uploaded = (upsertRemote.mock.calls[0][2] as typeof localEntity[])[0];
    expect(uploaded.entity_type).toBe('board');
    expect(uploaded.entity_id).toBe('board-mat-1');
    // 云端 JSON 往返后素材依旧完整
    const cloudContent = cloudRoundTrip(uploaded.content) as MaterialBoard;
    const byId = indexById(cloudContent.elements ?? []);
    for (const key of ['mat-img-1', 'mat-text-1', 'mat-rect-1', 'mat-pen-1']) {
      expect(byId.get(key), `上传到云端的素材 ${key}`).toBeDefined();
    }
  });

  it('设备 B 同步：云端画板素材被完整下载（applyRemote 收到四类素材）', async () => {
    const { runSync } = await import('./sync-engine');
    const board = createMaterialBoard();
    const remoteEntity = syncEntityOf(board);

    const applyRemote = vi.fn().mockResolvedValue({ applied: 1 });
    const result = await runSync({
      client: {},
      user: { id: 'u1', email: 'e@example.com' },
      lastSyncTime: null,
      collectLocal: vi.fn().mockResolvedValue({ entities: [], stats: { total: 0 } }),
      fetchRemote: vi.fn().mockResolvedValue([remoteEntity]),
      upsertRemote: vi.fn().mockResolvedValue({ data: null, error: null }),
      softDeleteRemote: vi.fn().mockResolvedValue({ data: null, error: null }),
      applyRemote,
    });

    expect(result.success).toBe(true);
    expect(result.downloaded).toBe(1);
    expect(applyRemote).toHaveBeenCalledTimes(1);
    const downloaded = applyRemote.mock.calls[0][0].entities[0] as typeof remoteEntity;
    const cloudContent = cloudRoundTrip(downloaded.content) as MaterialBoard;
    const byId = indexById(cloudContent.elements ?? []);
    expect(extractSlateText(byId.get('mat-text-1')!.text)).toBe('云端同步的文字素材 E2E');
    expect(byId.get('mat-img-1')!.url).toBe('/asset-library/content-abc123.png');
    expect(byId.get('mat-rect-1')!.shape).toBe('rectangle');
    expect(byId.get('mat-pen-1')!.shape).toBe('feltTipPen');
  });
});

// ---------- 6. 媒体同步：画布图片二进制进入同步管线 ----------

describe('media-sync：画布图片素材的媒体同步', () => {
  const repoMocks = vi.hoisted(() => ({
    fetchRemoteMedia: vi.fn().mockResolvedValue({ media: [], error: null }),
    upsertRemoteMedia: vi.fn().mockResolvedValue({ error: null }),
  }));

  const cacheMocks = vi.hoisted(() => ({
    getCachedBlob: vi.fn(),
    getAllCacheMetadata: vi.fn().mockResolvedValue([]),
    cacheToCacheStorageOnly: vi.fn().mockResolvedValue(true),
  }));

  vi.mock('./repository', () => ({
    fetchRemoteMedia: repoMocks.fetchRemoteMedia,
    upsertRemoteMedia: repoMocks.upsertRemoteMedia,
    fetchRemoteEntitiesByTypes: vi.fn(async () => ({ entities: [] })),
    fetchRemoteEntity: vi.fn(async () => ({ entity: null })),
    fetchRemoteBoardMetadata: vi.fn(async () => ({ boards: [] })),
    updateRemoteEntityCas: vi.fn(async () => ({ savedAt: 0 })),
    upsertRemoteEntityReturnTs: vi.fn(async () => ({ savedAt: 0 })),
    deleteRemoteEntitiesHard: vi.fn(async () => ({})),
  }));

  vi.mock('../unified-cache-service', () => ({
    unifiedCacheService: {
      getCachedBlob: cacheMocks.getCachedBlob,
      getAllCacheMetadata: cacheMocks.getAllCacheMetadata,
      cacheToCacheStorageOnly: cacheMocks.cacheToCacheStorageOnly,
    },
  }));

  function makeClient() {
    const uploaded: Array<{ path: string; blob: Blob }> = [];
    const client = {
      auth: {
        getSession: async () => ({
          data: {
            session: {
              user: { id: 'u1', email: 'e2e_user@yjk.com' },
            },
          },
        }),
      },
      from: (table: string) => {
        if (table === 'user_profiles') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      storage: {
        from: () => ({
          upload: async (path: string, blob: Blob) => {
            uploaded.push({ path, blob });
            return { error: null };
          },
        }),
      },
    };
    return { client, uploaded };
  }

  beforeEach(() => {
    repoMocks.fetchRemoteMedia.mockClear();
    repoMocks.upsertRemoteMedia.mockClear();
    cacheMocks.getCachedBlob.mockClear();
    cacheMocks.getAllCacheMetadata.mockClear();
    cacheMocks.cacheToCacheStorageOnly.mockClear();
    vi.stubGlobal('crypto', {
      subtle: {
        digest: async () => new Uint8Array(32).fill(7),
      },
    });
  });

  it('画布图片（虚拟路径）→ 上传到 Storage 并写入媒体元数据（URL 保真）', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    const imageUrl = '/asset-library/content-abc123.png';
    const blob = new Blob(['fake-png-bytes'], { type: 'image/png' }) as Blob & {
      arrayBuffer?: () => Promise<ArrayBuffer>;
    };
    // jsdom 的 Blob 未实现 arrayBuffer()（生产浏览器均有），测试中补齐
    blob.arrayBuffer = async () => new TextEncoder().encode('fake-png-bytes').buffer;
    // 模拟画布图片已进入本地缓存（unifiedCacheService 是画布图片的实际存放处）
    cacheMocks.getAllCacheMetadata.mockResolvedValue([
      { id: 'm1', url: imageUrl, cachedAt: Date.now() },
    ]);
    cacheMocks.getCachedBlob.mockResolvedValue(blob);

    const { client, uploaded } = makeClient();
    const stats = await syncMediaToSupabase(
      { client } as never,
      'u1'
    );

    // 上传成功 1 个（画布图片二进制进入云存储）
    expect(stats).toEqual({ uploaded: 1, downloaded: 0, failed: 0 });
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].path).toMatch(/^e2e_user\/image\/[0-9a-f]{64}\.png$/);
    // 元数据记录的 url 与画布元素 url 完全一致（设备 B 据此回填图片）
    expect(repoMocks.upsertRemoteMedia).toHaveBeenCalledTimes(1);
    const items = repoMocks.upsertRemoteMedia.mock.calls[0][2] as Array<{
      url: string;
      type: string;
      mimeType: string;
      storagePath: string;
    }>;
    expect(items[0].url).toBe(imageUrl);
    expect(items[0].type).toBe('image');
    expect(items[0].mimeType).toBe('image/png');
  });

  it('远端已有图片元数据且内容一致 → 不重复上传', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    const imageUrl = '/asset-library/content-abc123.png';
    cacheMocks.getAllCacheMetadata.mockResolvedValue([
      { id: 'm1', url: imageUrl, cachedAt: Date.now() },
    ]);
    // 本地 blob 为 PNG 魔数 + sha256 固定 07*32（beforeEach stub）：
    // storage_path 哈希与本地一致 = 云端对象与本地内容对应，无需重传
    const blob = new Blob(['fake-png-bytes'], { type: 'image/png' }) as Blob & {
      arrayBuffer?: () => Promise<ArrayBuffer>;
    };
    blob.arrayBuffer = async () => new TextEncoder().encode('fake-png-bytes').buffer;
    cacheMocks.getCachedBlob.mockResolvedValue(blob);
    repoMocks.fetchRemoteMedia.mockResolvedValue({
      media: [
        {
          url: imageUrl,
          type: 'image',
          storagePath:
            'e2e_user/image/0707070707070707070707070707070707070707070707070707070707070707.png',
        },
      ],
      error: null,
    });
    const { client, uploaded } = makeClient();
    const stats = await syncMediaToSupabase({ client } as never, 'u1');
    expect(stats.uploaded).toBe(0);
    expect(uploaded).toHaveLength(0);
    expect(repoMocks.upsertRemoteMedia).not.toHaveBeenCalled();
  });

  it('失败缓存元数据（size=0/cacheWarning）不被当作本地已有 → 仍从远端下载（回归）', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    const imageUrl = '/asset-library/content-abc123.png';

    // 本地只有「失败缓存元数据」：cacheImage 对虚拟 URL fetch 404 后写入的
    // size=0 + cacheWarning 条目（无二进制）——之前会被误判为本地已有而跳过下载
    cacheMocks.getAllCacheMetadata.mockResolvedValue([
      {
        url: imageUrl,
        type: 'image',
        mimeType: 'image/png',
        size: 0,
        cachedAt: Date.now(),
        lastUsed: Date.now(),
        metadata: { cacheWarning: { reason: 'fetch_failed' } },
      },
    ]);
    // 远端媒体索引中存在该图片（设备 A 已上传成功）
    repoMocks.fetchRemoteMedia.mockResolvedValue({
      media: [{ url: imageUrl, type: 'image', storagePath: 'e2e_user/image/x.png' }],
      error: null,
    });

    const client = {
      auth: {
        getSession: async () => ({
          data: {
            session: { user: { id: 'u1', email: 'e2e_user@yjk.com' } },
          },
        }),
      },
      from: (table: string) => {
        if (table === 'user_profiles') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      storage: {
        from: () => ({
          download: async () => ({
            data: new Blob(['fake-png-bytes'], { type: 'image/png' }),
            error: null,
          }),
        }),
      },
    };

    const stats = await syncMediaToSupabase({ client } as never, 'u1');
    // 失败元数据不阻塞下载：二进制被下载并写回本地 Cache（下载 1 个）
    expect(stats).toEqual({ uploaded: 0, downloaded: 1, failed: 0 });
    expect(cacheMocks.cacheToCacheStorageOnly).toHaveBeenCalledTimes(1);
    expect(cacheMocks.cacheToCacheStorageOnly).toHaveBeenCalledWith(
      imageUrl,
      expect.any(Blob)
    );
    // 失败元数据自身也不应被当作本地媒体上传（无二进制可传）
    expect(repoMocks.upsertRemoteMedia).not.toHaveBeenCalled();
  });

  it('本地仅有缓存元数据（size>0，如 applyRemote 回填）但无 blob → 仍从远端下载（回归）', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    const imageUrl = '/asset-library/content-abc123.png';

    // 设备 B 同步画板后：applyRemote 回填了 cache_media 元数据
    // （size>0、无 cacheWarning——collectLocalMediaUrls 会把它计入本地已有），
    // 但二进制尚未下载（Cache 无 blob）——元数据 ≠ blob，不能仅凭元数据跳过下载
    cacheMocks.getAllCacheMetadata.mockResolvedValue([
      {
        url: imageUrl,
        type: 'image',
        mimeType: 'image/png',
        size: 12345,
        cachedAt: Date.now(),
        lastUsed: Date.now(),
        metadata: { taskId: 't1' },
      },
    ]);
    cacheMocks.getCachedBlob.mockResolvedValue(null); // 本机无真实 blob
    repoMocks.fetchRemoteMedia.mockResolvedValue({
      media: [{ url: imageUrl, type: 'image', storagePath: 'e2e_user/image/x.png' }],
      error: null,
    });

    const client = {
      auth: {
        getSession: async () => ({
          data: {
            session: { user: { id: 'u1', email: 'e2e_user@yjk.com' } },
          },
        }),
      },
      from: (table: string) => {
        if (table === 'user_profiles') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      storage: {
        from: () => ({
          download: async () => ({
            data: new Blob(['fake-png-bytes'], { type: 'image/png' }),
            error: null,
          }),
        }),
      },
    };

    const stats = await syncMediaToSupabase({ client } as never, 'u1');
    // 即使本地已有元数据，只要无 blob 就必须下载
    expect(stats).toEqual({ uploaded: 0, downloaded: 1, failed: 0 });
    expect(cacheMocks.getCachedBlob).toHaveBeenCalledWith(imageUrl);
    expect(cacheMocks.cacheToCacheStorageOnly).toHaveBeenCalledTimes(1);
  });

  it('本地已有真实 blob → 跳过下载', async () => {
    const { syncMediaToSupabase } = await import('./media-sync');
    const imageUrl = '/asset-library/content-abc123.png';
    cacheMocks.getAllCacheMetadata.mockResolvedValue([
      {
        url: imageUrl,
        type: 'image',
        mimeType: 'image/png',
        size: 12345,
        cachedAt: Date.now(),
        lastUsed: Date.now(),
        metadata: {},
      },
    ]);
    // 本地已有真实媒体 blob（PNG 魔数 + arrayBuffer 补齐），且远端行哈希一致：
    // 上传与下载都应跳过
    const blob = new Blob(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]),
      { type: 'image/png' }
    ) as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
    blob.arrayBuffer = async () =>
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]).buffer;
    cacheMocks.getCachedBlob.mockResolvedValue(blob);
    repoMocks.fetchRemoteMedia.mockResolvedValue({
      media: [
        {
          url: imageUrl,
          type: 'image',
          storagePath:
            'e2e_user/image/0707070707070707070707070707070707070707070707070707070707070707.png',
        },
      ],
      error: null,
    });
    const client = {
      auth: {
        getSession: async () => ({
          data: {
            session: { user: { id: 'u1', email: 'e2e_user@yjk.com' } },
          },
        }),
      },
      from: () => {
        throw new Error('unexpected table');
      },
      storage: {
        from: () => ({
          download: async () => {
            throw new Error('不应发起下载');
          },
        }),
      },
    };
    const stats = await syncMediaToSupabase({ client } as never, 'u1');
    expect(stats).toEqual({ uploaded: 0, downloaded: 0, failed: 0 });
  });
});
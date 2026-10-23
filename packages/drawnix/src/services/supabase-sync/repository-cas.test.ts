/**
 * repository CAS / 真删除单测（openspec remove-local-persistence）
 *
 * 用最小 fake client 校验 PostgREST 查询形状：
 * - CAS 条件更新必须 .eq('updated_at', iso) 且 0 行命中返回 conflict
 * - 新建走 insert 且不带客户端 updated_at（服务端触发器生成）
 * - insert 唯一键冲突（23505）映射为 conflict
 * - 真删除按 entity_type 分组 in 批量
 */

import { describe, it, expect } from 'vitest';
import {
  updateRemoteEntityCas,
  deleteRemoteEntitiesHard,
  fetchRemoteBoardMetadata,
} from './repository';
import type { SupabaseSyncConfig } from './types';

const CONFIG = { client: {} } as unknown as SupabaseSyncConfig;

/** 记录调用路径的极简 query builder */
function createBuilder(rows: Array<Record<string, unknown>> = []) {
  const ops: string[] = [];
  const filters: Array<[string, string, unknown]> = [];
  let result: { data: unknown; error: unknown } = { data: rows, error: null };
  const builder: Record<string, unknown> = {};
  const chain = (name: string) => {
    ops.push(name);
    return builder;
  };
  const filter = (col: string, op: string, val: unknown) => {
    filters.push([col, op, val]);
    return builder;
  };
  Object.assign(builder, {
    select: (cols: string) => {
      ops.push(`select(${cols})`);
      return builder;
    },
    insert: (row: Record<string, unknown>) => {
      ops.push(`insert(${JSON.stringify(row)})`);
      return builder;
    },
    update: (patch: Record<string, unknown>) => {
      ops.push(`update(${JSON.stringify(patch)})`);
      return builder;
    },
    upsert: (rowsIn: Array<Record<string, unknown>>, opts: unknown) => {
      ops.push(`upsert(${JSON.stringify(rowsIn)},${JSON.stringify(opts)})`);
      return builder;
    },
    delete: () => chain('delete'),
    eq: (col: string, val: unknown) => filter(col, 'eq', val),
    in: (col: string, vals: string[]) => filter(col, 'in', vals),
    order: () => builder,
    range: () => builder,
    limit: () => builder,
    then: (
      resolve: (value: { data: unknown; error: unknown }) => void
    ) =>
      // supabase-js 语义：查询失败也是 resolve({ data, error })，不 reject
      Promise.resolve().then(() => resolve(result)),
  });
  return {
    builder,
    ops,
    filters,
    setResult: (data: unknown, error: unknown = null) => {
      result = { data, error };
    },
  };
}

function makeClient(table: string, builder: Record<string, unknown>) {
  return {
    from: (name: string) => (name === table ? builder : {}),
  } as unknown as SupabaseSyncConfig['client'];
}

const ENTITY = {
  entity_type: 'board' as const,
  entity_id: 'b1',
  content: { name: '板' },
  checksum: 'abc',
  updated_at: 1,
  deleted_at: null,
};

describe('updateRemoteEntityCas', () => {
  it('条件更新携带 updated_at eq 过滤；0 行命中返回 conflict', async () => {
    const { builder, ops, filters, setResult } = createBuilder();
    setResult([], null); // 条件不命中 → 空结果
    const client = makeClient('user_sync_data', builder);

    const outcome = await updateRemoteEntityCas(
      { client } as SupabaseSyncConfig,
      'u1',
      ENTITY,
      1_700_000_000_000
    );

    expect(outcome.conflict).toBe(true);
    expect(ops.some((op) => op.startsWith('update('))).toBe(true);
    expect(ops.some((op) => op.includes('select(updated_at)'))).toBe(true);
    expect(filters).toContainEqual(['user_id', 'eq', 'u1']);
    expect(filters).toContainEqual(['entity_type', 'eq', 'board']);
    expect(filters).toContainEqual(['entity_id', 'eq', 'b1']);
    expect(filters).toContainEqual([
      'updated_at',
      'eq',
      new Date(1_700_000_000_000).toISOString(),
    ]);
    // 补丁不含客户端 updated_at（触发器生成）
    const updateOp = ops.find((op) => op.startsWith('update('))!;
    expect(updateOp).not.toContain('updated_at');
  });

  it('条件命中返回服务端 savedAt（epoch ms）', async () => {
    const iso = '2026-10-23T08:00:00.123+00:00';
    const { builder, setResult } = createBuilder();
    setResult([{ updated_at: iso }]);
    const client = makeClient('user_sync_data', builder);

    const outcome = await updateRemoteEntityCas(
      { client } as SupabaseSyncConfig,
      'u1',
      ENTITY,
      1_700_000_000_000
    );

    expect(outcome.conflict).toBeUndefined();
    expect(outcome.savedAt).toBe(Date.parse(iso));
  });

  it('base=0 走 insert（不带 updated_at，服务端生成）', async () => {
    const { builder, ops, setResult } = createBuilder();
    setResult([{ updated_at: '2026-10-23T08:00:00.000+00:00' }]);
    const client = makeClient('user_sync_data', builder);

    const outcome = await updateRemoteEntityCas(
      { client } as SupabaseSyncConfig,
      'u1',
      ENTITY,
      0
    );

    expect(outcome.savedAt).toBe(Date.parse('2026-10-23T08:00:00.000+00:00'));
    const insertOp = ops.find((op) => op.startsWith('insert('))!;
    expect(insertOp).not.toContain('"updated_at"');
    expect(insertOp).toContain('"deleted_at":null');
  });

  it('insert 唯一键冲突（23505）映射为 conflict', async () => {
    const { builder, setResult } = createBuilder();
    setResult(null, { code: '23505', message: 'duplicate key value' });
    const client = makeClient('user_sync_data', builder);

    const outcome = await updateRemoteEntityCas(
      { client } as SupabaseSyncConfig,
      'u1',
      ENTITY,
      0
    );

    expect(outcome.conflict).toBe(true);
  });
});

describe('deleteRemoteEntitiesHard', () => {
  it('按 entity_type 分组 in 批量删除', async () => {
    const builders: Array<ReturnType<typeof createBuilder>> = [];
    const client = {
      from: () => {
        const b = createBuilder();
        builders.push(b);
        return b.builder;
      },
    } as unknown as SupabaseSyncConfig['client'];

    const outcome = await deleteRemoteEntitiesHard(
      { client } as SupabaseSyncConfig,
      'u1',
      ['board:a', 'board:b', 'folder:c', 'folder:d']
    );

    expect(outcome.error).toBeUndefined();
    expect(builders).toHaveLength(2);
    // 第一组：board [a,b]；第二组：folder [c,d]
    const allFilters = builders.flatMap((b) => b.filters);
    expect(allFilters).toContainEqual(['entity_type', 'eq', 'board']);
    expect(allFilters).toContainEqual(['entity_id', 'in', ['a', 'b']]);
    expect(allFilters).toContainEqual(['entity_type', 'eq', 'folder']);
    expect(allFilters).toContainEqual(['entity_id', 'in', ['c', 'd']]);
    expect(builders.every((b) => b.ops.includes('delete'))).toBe(true);
  });

  it('空键列表直接返回，不发起请求', async () => {
    let called = 0;
    const client = {
      from: () => {
        called += 1;
        return createBuilder().builder;
      },
    } as unknown as SupabaseSyncConfig['client'];

    const outcome = await deleteRemoteEntitiesHard(
      { client } as SupabaseSyncConfig,
      'u1',
      []
    );
    expect(outcome.error).toBeUndefined();
    expect(called).toBe(0);
  });
});

describe('fetchRemoteBoardMetadata', () => {
  it('投影查询失败时退化为整行拉取并裁剪为元数据', async () => {
    let call = 0;
    const projectionBuilder = createBuilder();
    projectionBuilder.setResult(null, { message: 'projection unsupported' });
    const fullBuilder = createBuilder();
    // 退化路径走 order/range 分页链（fetchRemoteEntitiesByTypes）
    Object.assign(fullBuilder.builder, {
      in: () => fullBuilder.builder,
    });
    fullBuilder.setResult([
      {
        entity_type: 'board',
        entity_id: 'b9',
        content: {
          id: 'b9',
          name: '整行板',
          folderId: 'f1',
          order: 2,
          createdAt: 10,
          updatedAt: 20,
          elements: [{ id: 'el' }],
        },
        checksum: '',
        updated_at: '2026-10-23T08:00:00.000+00:00',
        deleted_at: null,
      },
    ]);
    const client = {
      from: () => {
        call += 1;
        return call === 1 ? projectionBuilder.builder : fullBuilder.builder;
      },
    } as unknown as SupabaseSyncConfig['client'];

    const { boards, error } = await fetchRemoteBoardMetadata(
      { client } as SupabaseSyncConfig,
      'u1'
    );

    expect(error).toBeUndefined();
    expect(boards).toHaveLength(1);
    expect(boards[0]).toMatchObject({
      id: 'b9',
      name: '整行板',
      folderId: 'f1',
      order: 2,
      rowUpdatedAt: Date.parse('2026-10-23T08:00:00.000+00:00'),
    });
  });
});

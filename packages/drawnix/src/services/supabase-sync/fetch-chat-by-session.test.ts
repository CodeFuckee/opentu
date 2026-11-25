// @vitest-environment jsdom
/**
 * fetchRemoteChatMessagesBySession 按会话过滤测试
 *
 * 2026-11-25 事故教训：chat_message 整类型拉取在巨型行场景下 PostgREST
 * 序列化必然 500。会话级读取用 content->>sessionId 服务端过滤 + 分页。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchRemoteChatMessagesBySession,
} from './repository';

function makeClient(pages: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ range: [number, number] }> = [];
  let page = 0;
  return {
    client: {
      from: (_table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              filter: () => ({
                order: () => ({
                  range: (from: number, to: number) => {
                    calls.push({ range: [from, to] });
                    const data = pages[Math.min(page, pages.length - 1)];
                    page += 1;
                    return Promise.resolve({ data, error: null });
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    },
    calls,
  };
}

describe('fetchRemoteChatMessagesBySession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('用 content->>sessionId 过滤并按 updated_at 分页取全量', async () => {
    const row = (id: string) => ({
      entity_type: 'chat_message',
      entity_id: id,
      content: { id, sessionId: 'sess1' },
      deleted_at: null,
    });
    // 第一页放满 500 行（=PAGE），逼出第二轮分页；第二页短页触发终止
    const fake = makeClient([
      Array.from({ length: 500 }, (_, i) => row(`m${i}`)),
      [row('m500')],
    ]);
    const { contents, error } = await fetchRemoteChatMessagesBySession(
      { client: fake.client } as never,
      'u1',
      'sess1'
    );
    expect(error).toBeUndefined();
    expect(contents).toHaveLength(501);
    expect(fake.calls.map((c) => c.range)).toEqual([
      [0, 499],
      [500, 999],
    ]);
  });

  it('查询报错时透传 error（调用方回退类型级拉取）', async () => {
    const fake = {
      client: {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                filter: () => ({
                  order: () => ({
                    range: () =>
                      Promise.resolve({ data: null, error: { message: 'x' } }),
                  }),
                }),
              }),
            }),
          }),
        }),
      },
    };
    const { contents, error } = await fetchRemoteChatMessagesBySession(
      { client: fake.client } as never,
      'u1',
      'sess1'
    );
    expect(contents).toHaveLength(0);
    expect(error).toBeTruthy();
  });
});

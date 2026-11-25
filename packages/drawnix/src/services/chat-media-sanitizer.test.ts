// @vitest-environment jsdom
/**
 * 聊天消息落库媒体消毒测试（2026-11-25 巨型 base64 行事故的落库守卫）
 *
 * 事故：workflow/聊天消息把参考图 base64 原样存进 chat_message（parts /
 * attachments[].data / aiContext.selection.images / workflow.steps[].args /
 * retryContext.referenceImages），单行 135MB、单账号 2.8GB → PostgREST
 * 拉取 500 + 渲染进程 OOM 崩溃。
 *
 * 守卫：落库前深遍历，≥512KB 的媒体 data URL 归档为内容寻址虚拟 URL；
 * 小于阈值保持内联；归档失败保留原样不阻塞保存。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeChatMessageForSave } from './chat-media-sanitizer';
import type { ChatMessage } from '../types/chat.types';

const mocks = vi.hoisted(() => ({
  cacheLocalMediaByContent: vi.fn(),
}));

vi.mock('./unified-cache-service', () => ({
  unifiedCacheService: {
    cacheLocalMediaByContent: mocks.cacheLocalMediaByContent,
  },
}));


/** 构造一个 data URL 字符串（内容长度可控） */
function makeDataUrl(mime: string, sizeKB: number): string {
  const payload = 'A'.repeat(Math.max(64, sizeKB * 1024 - 64));
  return `data:${mime};base64,${payload}`;
}

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg_test',
    sessionId: 'sess_1',
    role: 'user',
    content: '参考图生成',
    timestamp: 1,
    status: 'success',
    ...overrides,
  } as ChatMessage;
}

describe('sanitizeChatMessageForSave（落库媒体守卫）', () => {
  beforeEach(() => {
    mocks.cacheLocalMediaByContent.mockReset();
    mocks.cacheLocalMediaByContent.mockImplementation(
      async (blob: Blob, type: string) => {
        expect(blob.size).toBeGreaterThan(0);
        expect(['image', 'video', 'audio']).toContain(type);
        return { url: `/__aitu_cache__/${type}/content-archived.${type === 'image' ? 'png' : 'mp4'}`, contentHash: 'h', reused: false };
      }
    );
  });

  it('深遍历归档各位置的巨型 data URL（parts/attachments/aiContext/workflow.args/retryContext）', async () => {
    const big = makeDataUrl('image/png', 600);
    const { message, stats } = await sanitizeChatMessageForSave(
      makeMessage({
        parts: [
          { type: 'text', text: '参考图生成' },
          { type: 'data-file', data: { filename: 'a.png', mediaType: 'image/png', url: big } },
        ],
        attachments: [
          { id: 'att1', name: 'a.png', type: 'image/png', size: 0, data: big, isBlob: false },
        ],
        aiContext: { selection: { images: [big, makeDataUrl('image/jpeg', 600)] } },
        workflow: {
          id: 'wf',
          name: 'n',
          generationType: 'image',
          prompt: 'p',
          count: 1,
          steps: [
            { id: 's1', description: 'd', status: 'completed', mcp: 'generate_image', args: { referenceImages: [big] }, result: 'ok' },
          ],
          retryContext: { referenceImages: [big], aiContext: {} as never },
        },
      } as Partial<ChatMessage>) as ChatMessage
    );

    // 五个位置全部替换为归档 URL（同 data URL 共享一次归档 + 一处独立 jpeg）
    expect(stats.archived).toBe(2);
    expect(stats.failed).toBe(0);
    const serialized = JSON.stringify(message);
    expect(serialized).not.toContain(big);
    expect(serialized).toContain('/__aitu_cache__/image/content-archived.png');
    expect((message.parts[1] as any).data.url).toBe('/__aitu_cache__/image/content-archived.png');
    expect((message as any).workflow.steps[0].args.referenceImages[0]).toBe(
      '/__aitu_cache__/image/content-archived.png'
    );
  });

  it('小于阈值的小 data URL 保持内联', async () => {
    const small = makeDataUrl('image/png', 8);
    const { message, stats } = await sanitizeChatMessageForSave(
      makeMessage({ parts: [{ type: 'data-file', data: { filename: 's.png', mediaType: 'image/png', url: small } }] } as Partial<ChatMessage>) as ChatMessage
    );
    expect(stats.keptInline).toBe(1);
    expect(stats.archived).toBe(0);
    expect((message.parts[0] as any).data.url).toBe(small);
    expect(mocks.cacheLocalMediaByContent).not.toHaveBeenCalled();
  });

  it('归档失败保留原 data URL，不抛出（不阻塞保存）', async () => {
    mocks.cacheLocalMediaByContent.mockRejectedValue(new Error('quota'));
    const big = makeDataUrl('image/png', 600);
    const { message, stats } = await sanitizeChatMessageForSave(
      makeMessage({ attachments: [{ id: 'a', name: 'a', type: 'image/png', size: 0, data: big, isBlob: false }] } as Partial<ChatMessage>) as ChatMessage
    );
    expect(stats.failed).toBe(1);
    expect((message.attachments![0] as any).data).toBe(big);
  });

  it('非媒体 data URL（如 data:text/plain）不处理', async () => {
    const textUrl = `data:text/plain;base64,${'A'.repeat(600 * 1024)}`;
    const { message, stats } = await sanitizeChatMessageForSave(
      makeMessage({ parts: [{ type: 'text', text: textUrl }] } as Partial<ChatMessage>) as ChatMessage
    );
    expect(stats).toEqual({ archived: 0, failed: 0, keptInline: 0 });
    expect((message.parts[0] as any).text).toBe(textUrl);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gridImageTool } from '../photo-wall-tool';
import { inspirationBoardTool } from '../creative-photo-wall-tool';

const { createTaskMock, retryTaskMock, getTaskMock } = vi.hoisted(() => ({
  createTaskMock: vi.fn(),
  retryTaskMock: vi.fn(),
  getTaskMock: vi.fn(),
}));

vi.mock('../../../services/task-queue', () => ({
  taskQueueService: {
    createTask: createTaskMock,
    retryTask: retryTaskMock,
    getTask: getTaskMock,
  },
}));

vi.mock('../image-generation', () => ({
  getCurrentImageModel: () => 'gpt-image-2',
}));

describe('photo wall MCP tools', () => {
  beforeEach(() => {
    createTaskMock.mockReset();
    retryTaskMock.mockReset();
    getTaskMock.mockReset();

    createTaskMock.mockImplementation((params, type) => ({
      id: `task-${createTaskMock.mock.calls.length}`,
      type,
      status: 'processing',
      params,
    }));
  });

  it('passes grid image quality as resolution to the image task params', async () => {
    const result = await gridImageTool.execute(
      {
        theme: '可爱猫咪表情包',
        imageQuality: '4k',
      },
      { mode: 'queue' }
    );

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-image-2',
      params: {
        resolution: '4k',
      },
    });
    expect(result).toMatchObject({
      success: true,
      type: 'image',
    });
  });

  it('passes inspiration board quality as resolution to the image task params', async () => {
    const result = await inspirationBoardTool.execute(
      {
        theme: '城市街角 mood board',
        imageQuality: '2k',
      },
      { mode: 'queue' }
    );

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-image-2',
      params: {
        resolution: '2k',
      },
    });
    expect(result).toMatchObject({
      success: true,
      type: 'image',
    });
  });
});

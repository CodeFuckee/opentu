import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRecordWithCap,
  deleteRecordById,
  loadRecordsByKey,
  saveRecordsByKey,
  updateRecordById,
  type WorkflowRecordStorageOptions,
} from './record-storage';

const { getMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock('../../../services/kv-storage-service', () => ({
  kvStorageService: {
    get: getMock,
    set: setMock,
  },
}));

type TestRecord = {
  id: string;
  starred: boolean;
  label: string;
};

describe('record-storage', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
  });

  it('loads empty list when storage value is not an array', async () => {
    getMock.mockResolvedValue(null);

    await expect(loadRecordsByKey<TestRecord>('workflow:test')).resolves.toEqual([]);
  });

  it('normalizes records on load and save', async () => {
    const options: WorkflowRecordStorageOptions<TestRecord> = {
      normalizeRecord: (record) => ({
        ...record,
        label: record.label.trim(),
      }),
    };
    getMock.mockResolvedValue([{ id: 'a', starred: false, label: ' hello ' }]);

    await expect(loadRecordsByKey<TestRecord>('workflow:test', options)).resolves.toEqual([
      { id: 'a', starred: false, label: 'hello' },
    ]);

    await saveRecordsByKey(
      'workflow:test',
      [{ id: 'b', starred: false, label: ' world ' }],
      options
    );

    expect(setMock).toHaveBeenCalledWith('workflow:test', [
      { id: 'b', starred: false, label: 'world' },
    ]);
  });

  it('adds newest record and prunes the oldest non-starred record', async () => {
    const onPruneRecord = vi.fn();
    getMock.mockResolvedValue([
      { id: 'a', starred: false, label: 'A' },
      { id: 'b', starred: true, label: 'B' },
      { id: 'c', starred: false, label: 'C' },
    ] satisfies TestRecord[]);

    const records = await addRecordWithCap<TestRecord>(
      'workflow:test',
      { id: 'new', starred: false, label: 'New' },
      3,
      { onPruneRecord }
    );

    expect(records.map((record) => record.id)).toEqual(['new', 'a', 'b']);
    expect(onPruneRecord).toHaveBeenCalledWith({ id: 'c', starred: false, label: 'C' });
    expect(setMock).toHaveBeenCalledWith('workflow:test', [
      { id: 'new', starred: false, label: 'New' },
      { id: 'a', starred: false, label: 'A' },
      { id: 'b', starred: true, label: 'B' },
    ]);
  });

  it('keeps overflow records when all existing records are starred', async () => {
    getMock.mockResolvedValue([
      { id: 'a', starred: true, label: 'A' },
      { id: 'b', starred: true, label: 'B' },
    ] satisfies TestRecord[]);

    const records = await addRecordWithCap<TestRecord>(
      'workflow:test',
      { id: 'new', starred: true, label: 'New' },
      2
    );

    expect(records.map((record) => record.id)).toEqual(['new', 'a', 'b']);
    expect(setMock).toHaveBeenCalledWith('workflow:test', [
      { id: 'new', starred: true, label: 'New' },
      { id: 'a', starred: true, label: 'A' },
      { id: 'b', starred: true, label: 'B' },
    ]);
  });

  it('updates a record by id and normalizes the merged result', async () => {
    const options: WorkflowRecordStorageOptions<TestRecord> = {
      normalizeRecord: (record) => ({
        ...record,
        label: record.label.trim(),
      }),
    };
    getMock.mockResolvedValue([{ id: 'a', starred: false, label: 'Old' }] satisfies TestRecord[]);

    const records = await updateRecordById<TestRecord>(
      'workflow:test',
      'a',
      { label: ' New ' },
      options
    );

    expect(records).toEqual([{ id: 'a', starred: false, label: 'New' }]);
    expect(setMock).toHaveBeenCalledWith('workflow:test', [
      { id: 'a', starred: false, label: 'New' },
    ]);
  });

  it('deletes a record by id and triggers delete hook', async () => {
    const onDeleteRecord = vi.fn();
    getMock.mockResolvedValue([
      { id: 'a', starred: false, label: 'A' },
      { id: 'b', starred: true, label: 'B' },
    ] satisfies TestRecord[]);

    const records = await deleteRecordById<TestRecord>('workflow:test', 'b', {
      onDeleteRecord,
    });

    expect(records).toEqual([{ id: 'a', starred: false, label: 'A' }]);
    expect(setMock).toHaveBeenCalledWith('workflow:test', [
      { id: 'a', starred: false, label: 'A' },
    ]);
    expect(onDeleteRecord).toHaveBeenCalledWith({ id: 'b', starred: true, label: 'B' });
  });

  it('serializes concurrent writes so no record is lost', async () => {
    // 模拟真实 KV 语义：get 读当前已存值，set 覆盖并持久化
    let stored: TestRecord[] = [];
    getMock.mockImplementation(async () => stored);
    setMock.mockImplementation(async (_key: string, value: TestRecord[]) => {
      stored = value;
    });

    await Promise.all([
      addRecordWithCap<TestRecord>(
        'workflow:concurrent',
        { id: 'a', starred: false, label: 'A' },
        10
      ),
      addRecordWithCap<TestRecord>(
        'workflow:concurrent',
        { id: 'b', starred: false, label: 'B' },
        10
      ),
      updateRecordById<TestRecord>('workflow:concurrent', 'a', { label: 'A2' }),
    ]);

    const result = await loadRecordsByKey<TestRecord>('workflow:concurrent');
    expect(result.map((record) => record.id).sort()).toEqual(['a', 'b']);
    expect(result.find((record) => record.id === 'a')?.label).toBe('A2');
  });
});

/**
 * 「智能抠图」结果持久化:编辑器产出的 data URL →
 * 缓存为虚拟路径(/__aitu_cache__/image/...)并读取自然尺寸。
 * 与 popup-toolbar「编辑图片」保存链路同款;抽出的目的是
 * 侧边栏/素材库入口复用同一条落库路径。
 */
import { unifiedCacheService } from '../../services/unified-cache-service';
import { getImageNaturalSize } from '../../utils/image-natural-size';

export interface PersistedEditResult {
  stableUrl: string;
  width: number;
  height: number;
}

export async function persistEditedImageToVirtualPath(
  editedDataUrl: string
): Promise<PersistedEditResult> {
  const taskId = `edited-image-${Date.now()}`;
  const stableUrl = `/__aitu_cache__/image/${taskId}.png`;

  const response = await fetch(editedDataUrl);
  const blob = await response.blob();
  await unifiedCacheService.cacheMediaFromBlob(stableUrl, blob, 'image', {
    taskId,
  });

  // data URL 自带头部尺寸信息,加载失败时回退 1×1 避免阻塞插入
  const { width, height } = await getImageNaturalSize(editedDataUrl, 1, 1);

  return { stableUrl, width, height };
}

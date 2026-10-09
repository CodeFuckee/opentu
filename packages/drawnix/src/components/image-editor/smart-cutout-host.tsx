/**
 * 智能抠图宿主:订阅 smart-cutout-launcher 的抠图请求,在画布上下文内
 * 打开图片编辑器(直落抠图模式),并接管「插入新图片/覆盖原图」保存链路
 * (与 popup-toolbar「编辑图片」同款:虚拟路径缓存 → insertImageFromUrl /
 * calculateEditedImagePoints + Transforms.setNode)。
 * 渲染位置:DrawnixContent 内 UnifiedToolbar 旁(board 就绪后才有意义)。
 */
import React, { useEffect, useState } from 'react';
import { PlaitBoard, Transforms, getViewportOrigination } from '@plait/core';
import { MessagePlugin } from '../../utils/message-plugin';
import { insertImageFromUrl } from '../../data/image';
import { calculateEditedImagePoints } from '../../utils/image';
import { ImageEditor } from './ImageEditor';
import {
  SmartCutoutRequest,
  subscribeSmartCutout,
} from './smart-cutout-launcher';
import { persistEditedImageToVirtualPath } from './smart-cutout-persist';

export interface SmartCutoutHostProps {
  /** 画布实例;未初始化(为空)时不订阅渲染 */
  board: PlaitBoard | null;
}

export const SmartCutoutHost: React.FC<SmartCutoutHostProps> = ({ board }) => {
  const [request, setRequest] = useState<SmartCutoutRequest | null>(null);

  useEffect(() => {
    if (!board) {
      return;
    }
    return subscribeSmartCutout(setRequest);
  }, [board]);

  if (!board || !request) {
    return null;
  }

  const sourceElement = request.sourceElement;

  const handleInsert = async (editedDataUrl: string) => {
    try {
      const { stableUrl, width, height } =
        await persistEditedImageToVirtualPath(editedDataUrl);

      // 有画布来源:插到原图右侧留 20 间距;无来源:视口中心偏内
      const origination = getViewportOrigination(board);
      const offsetX = sourceElement
        ? sourceElement.points[1][0] - sourceElement.points[0][0] + 20
        : 0;
      const baseX = sourceElement
        ? sourceElement.points[0][0]
        : origination
        ? origination[0] + 100
        : 100;
      const baseY = sourceElement
        ? sourceElement.points[0][1]
        : origination
        ? origination[1] + 100
        : 100;

      await insertImageFromUrl(
        board,
        stableUrl,
        [baseX + offsetX, baseY],
        false,
        { width, height },
        false,
        true
      );
      setRequest(null);
    } catch (error) {
      console.error('[SmartCutout] 插入失败:', error);
      MessagePlugin.error('插入失败');
    }
  };

  const handleOverwrite = async (editedDataUrl: string) => {
    if (!sourceElement) {
      return;
    }
    try {
      const { stableUrl, width, height } =
        await persistEditedImageToVirtualPath(editedDataUrl);

      const elementIndex = board.children.findIndex(
        (child) => child.id === sourceElement.id
      );
      if (elementIndex < 0) {
        // 原图已被删除(如编辑期间撤销),降级为不动作并提示
        MessagePlugin.warning('原图已不在画布上,已取消覆盖');
        setRequest(null);
        return;
      }

      const element = board.children[elementIndex];
      const { newPoints } = await calculateEditedImagePoints(
        {
          url: sourceElement.url,
          width: sourceElement.width,
          height: sourceElement.height,
          points: sourceElement.points,
        },
        width,
        height
      );

      Transforms.setNode(
        board,
        {
          url: stableUrl,
          width,
          height,
          points: newPoints,
        },
        [elementIndex]
      );
      setRequest(null);
    } catch (error) {
      console.error('[SmartCutout] 覆盖失败:', error);
      MessagePlugin.error('更新失败');
    }
  };

  return (
    <ImageEditor
      visible
      imageUrl={request.imageUrl}
      initialMode="cutout"
      showOverwrite={!!sourceElement}
      onClose={() => setRequest(null)}
      onInsert={handleInsert}
      onOverwrite={handleOverwrite}
    />
  );
};

export default SmartCutoutHost;

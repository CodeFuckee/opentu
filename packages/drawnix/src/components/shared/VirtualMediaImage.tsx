/**
 * 虚拟媒体图片组件
 *
 * src 为虚拟媒体路径（/asset-library/、/__aitu_cache__/ 等）时，非安全上下文
 * （纯 HTTP 内网部署）没有 Service Worker 拦截，<img> 直指虚拟路径必然 404——
 * 经 useVirtualMediaObjectUrl 从 Cache Storage / IndexedDB 兜底库解析为 blob URL
 * 展示；data:/http(s): 等 URL 原样透传。
 *
 * 2026-11-25 起聊天附件/参考图落库为内容寻址虚拟 URL（巨型 base64 行事故的
 * 入口修复），聊天历史与输入条预览的图片展示统一走本组件。
 */
import React from 'react';
import { useVirtualMediaObjectUrl } from '../../hooks/useVirtualMediaObjectUrl';

export interface VirtualMediaImageProps
  extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
}

export const VirtualMediaImage: React.FC<VirtualMediaImageProps> = ({
  src,
  alt = '',
  ...imgProps
}) => {
  const resolvedSrc = useVirtualMediaObjectUrl(src);
  return (
    <img
      {...imgProps}
      src={resolvedSrc ?? ''}
      alt={alt}
      loading={imgProps.loading ?? 'lazy'}
      decoding={imgProps.decoding ?? 'async'}
    />
  );
};

import React, { useRef, useEffect, useState } from 'react';
import classNames from 'classnames';

export interface VideoItem {
  url: string;
  width?: number;
  height?: number;
  poster?: string;
  videoType?: string;
}

export interface VideoProps {
  videoItem: VideoItem;
  isFocus?: boolean;
  isSelected?: boolean;
  readonly?: boolean;
}

export const Video: React.FC<VideoProps> = (props: VideoProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoError, setVideoError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const { videoItem, isFocus = false, isSelected = false, readonly = false } = props;
  const { url: rawUrl, poster, videoType } = videoItem;

  // 清理 URL 中的 #video 标识符（用于视频类型识别，但不影响实际播放）
  const url = rawUrl?.replace('#video', '') || '';
  
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      const handleLoadedData = () => {
        setIsLoading(false);
        setVideoError(false);
      };
      
      const handleError = () => {
        setIsLoading(false);
        setVideoError(true);
      };

      video.addEventListener('loadeddata', handleLoadedData);
      video.addEventListener('error', handleError);

      return () => {
        video.removeEventListener('loadeddata', handleLoadedData);
        video.removeEventListener('error', handleError);
      };
    }
    return undefined;
  }, [url]);

  const stopCanvasPropagation = (e: React.SyntheticEvent) => {
    if (readonly) {
      e.stopPropagation();
    }
  };

  const handleVideoClick = (e: React.MouseEvent) => {
    if (readonly) {
      e.stopPropagation();
      // 在只读模式下，点击视频在新窗口打开
      e.preventDefault();
      window.open(url, '_blank', 'noopener');
    }
  };

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
    borderRadius: '4px',
    overflow: 'hidden',
  };

  if (videoError) {
    return (
      <div
        style={containerStyle}
        data-slideshow-media-control="true"
        onClick={handleVideoClick}
        onPointerDown={stopCanvasPropagation}
        onPointerUp={stopCanvasPropagation}
      >
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: '#666',
          backgroundColor: '#f5f5f5',
          cursor: readonly ? 'pointer' : 'default',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '8px' }}>🎬</div>
          <div style={{ fontSize: '14px', textAlign: 'center', padding: '0 16px' }}>
            Video failed to load
          </div>
          {readonly && (
            <div style={{ fontSize: '12px', color: '#999', marginTop: '4px' }}>
              Click to open in new window
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      style={containerStyle}
      data-slideshow-media-control="true"
      onClick={handleVideoClick}
      onPointerDown={stopCanvasPropagation}
      onPointerUp={stopCanvasPropagation}
    >
      {isLoading && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          zIndex: 1,
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '24px', marginBottom: '8px' }}>⏳</div>
            <div style={{ fontSize: '14px' }}>Loading video...</div>
          </div>
        </div>
      )}
      <video
        ref={videoRef}
        data-slideshow-media-control="true"
        src={url}
        poster={poster}
        width="100%"
        height="100%"
        controls={!readonly}
        muted
        playsInline
        draggable={false}
        className={classNames('video-origin', {
          'video-origin--focus': isFocus,
          'video-origin--selected': isSelected,
        })}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
        }}
        onPointerDown={stopCanvasPropagation}
        onPointerUp={stopCanvasPropagation}
        onError={() => setVideoError(true)}
      />
      {readonly && (
        <div style={{
          position: 'absolute',
          top: '8px',
          right: '8px',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          color: 'white',
          padding: '4px 8px',
          borderRadius: '4px',
          fontSize: '12px',
          pointerEvents: 'none',
        }}>
          🎬 Video
        </div>
      )}
    </div>
  );
};

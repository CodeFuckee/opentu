import React from 'react';
import { useImageQuota } from '../../hooks/useImageQuota';
import './image-quota-banner.scss';

/**
 * 生图月度额度展示条：
 * - 未登录/托管未启用 → 不渲染
 * - 展示"本月剩余 N 张"；耗尽时高亮提示
 */
export function ImageQuotaBanner(): React.ReactNode {
  const { managed, quota } = useImageQuota();

  if (!managed || !quota) {
    return null;
  }

  const exhausted = quota.remaining <= 0;
  const lowRemaining = !exhausted && quota.remaining <= Math.max(10, Math.ceil(quota.limit * 0.1));

  const className = [
    'image-quota-banner',
    exhausted ? 'image-quota-banner--exhausted' : '',
    lowRemaining ? 'image-quota-banner--low' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <span className="image-quota-banner__icon" aria-hidden>
        🖼️
      </span>
      {exhausted ? (
        <span>本月生图额度已用完（{quota.used}/{quota.limit}），下月自动恢复</span>
      ) : (
        <span>
          本月剩余额度：{quota.remaining} / {quota.limit} 张
        </span>
      )}
    </div>
  );
}

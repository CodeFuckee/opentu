/**
 * checksum 纯函数
 *
 * 内容校验和用于增量同步变更检测（与 github-sync 的 calculateChecksum 同算法，保持格式稳定）。
 * 实体键（entityKey）用于在本地/远程集合间映射实体："{entityType}:{entityId}"。
 */

/** 让出主线程（等效 @aitu/utils 的 yieldToMain，避免引入懒加载依赖） */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 计算字符串的简单校验和（32 位 FNV 风格，字符串化） */
export function calculateChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // 保持 32 位
  }
  return Math.abs(hash).toString(36);
}

/** 拼接实体键：{entityType}:{entityId} */
export function entityKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** 解析实体键；非法返回 null（entity_id 可含冒号，取第一个分隔符） */
export function parseEntityKey(
  key: string
): { entityType: string; entityId: string } | null {
  if (!key) {
    return null;
  }
  const separator = key.indexOf(':');
  if (separator <= 0) {
    return null;
  }
  return {
    entityType: key.slice(0, separator),
    entityId: key.slice(separator + 1),
  };
}
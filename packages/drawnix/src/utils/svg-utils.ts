export interface SvgDimensions {
  width: number;
  height: number;
}

const DEFAULT_SVG_DIMENSIONS: SvgDimensions = {
  width: 400,
  height: 400,
};

/**
 * 剥离不可信 SVG（LLM 生成/外部导入）中的活动内容：
 * <script>、<foreignObject>、on* 事件属性、javascript: 链接。
 * 当前 SVG 均经 <img src="data:image/svg+xml,..."> 沙箱渲染，
 * 此消毒用于防止未来改走 DOM 插入/导出内联路径时的 XSS。
 */
export function sanitizeSvgForEmbed(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<foreignObject\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /\s+(?:xlink:href|href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi,
      ''
    );
}

export function normalizeSvg(svg: string): string {
  let normalized = svg.trim();
  if (!normalized.includes('xmlns=')) {
    normalized = normalized.replace(
      '<svg',
      '<svg xmlns="http://www.w3.org/2000/svg"'
    );
  }
  return normalized;
}

export function parseSvgDimensions(svg: string): SvgDimensions {
  const viewBoxMatch = svg.match(/viewBox=["']([^"']+)["']/i);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].split(/\s+/).map(Number);
    if (parts.length >= 4 && parts[2] && parts[3]) {
      return { width: parts[2], height: parts[3] };
    }
  }

  const widthMatch = svg.match(/width=["'](\d+)(?:px)?["']/i);
  const heightMatch = svg.match(/height=["'](\d+)(?:px)?["']/i);
  if (widthMatch && heightMatch) {
    return {
      width: parseInt(widthMatch[1]),
      height: parseInt(heightMatch[1]),
    };
  }

  return DEFAULT_SVG_DIMENSIONS;
}

export function svgToDataUrl(svg: string): string {
  const sanitized = sanitizeSvgForEmbed(svg);
  const encoded = encodeURIComponent(sanitized)
    .replace(/'/g, '%27')
    .replace(/"/g, '%22');
  return `data:image/svg+xml,${encoded}`;
}

/**
 * 文档元数据工具
 * 用于从测试结果中提取手册生成所需的元数据
 */

export interface DocCategory {
  id: string;
  name: string;
  order: number;
  description?: string;
}

export interface DocPage {
  id: string;
  categoryId: string;
  title: string;
  description: string;
  steps: DocStep[];
  tags: string[];
}

export interface DocStep {
  order: number;
  title: string;
  description: string;
  screenshot?: string;
  note?: string;
}

/**
 * 预定义的文档分类
 */
export const DOC_CATEGORIES: DocCategory[] = [
  { id: 'getting-started', name: '快速开始', order: 1, description: '快速上手 Yue画布 的基本操作' },
  { id: 'drawing', name: '绘图功能', order: 2, description: '使用各种绘图工具' },
  { id: 'ai-generation', name: 'AI 生成', order: 3, description: 'AI 图片和视频生成' },
  { id: 'mindmap', name: '思维导图', order: 4, description: '创建和编辑思维导图' },
  { id: 'media-library', name: '素材库', order: 5, description: '管理和使用素材' },
  { id: 'project', name: '项目管理', order: 6, description: '管理画板和项目' },
  { id: 'settings', name: '设置', order: 7, description: '配置应用设置' },
  { id: 'advanced', name: '高级功能', order: 8, description: '高级功能和技巧' },
];

/**
 * 从测试注解中提取手册元数据
 */
export function extractManualMetadata(annotations: Array<{ type: string; description?: string }>) {
  const manualAnnotations = annotations.filter(a => a.type === 'manual');
  
  return manualAnnotations.map(a => {
    try {
      return JSON.parse(a.description || '{}');
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * 生成文档 ID
 */
export function generateDocId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * 按分类组织文档页面
 */
export function organizeDocPages(pages: DocPage[]): Map<string, DocPage[]> {
  const organized = new Map<string, DocPage[]>();
  
  for (const category of DOC_CATEGORIES) {
    organized.set(category.id, []);
  }
  
  for (const page of pages) {
    const categoryPages = organized.get(page.categoryId);
    if (categoryPages) {
      categoryPages.push(page);
    } else {
      // 未分类的放到高级功能
      const advancedPages = organized.get('advanced');
      if (advancedPages) {
        advancedPages.push(page);
      }
    }
  }
  
  return organized;
}

/**
 * 格式化步骤描述
 */
export function formatStepDescription(step: DocStep): string {
  let desc = `**${step.order}. ${step.title}**\n\n${step.description}`;
  
  if (step.note) {
    desc += `\n\n> 💡 ${step.note}`;
  }
  
  return desc;
}

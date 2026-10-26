/**
 * Inspiration Board Constants
 *
 * 灵感创意板块常量配置
 */

import { InspirationCategory, InspirationTemplate } from './types';

/**
 * 每页显示的模版数量
 */
export const ITEMS_PER_PAGE = 3;

const GRID_IMAGE_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
  <rect width="420" height="420" rx="34" fill="#EDF2FB"/>
  <rect x="38" y="46" width="344" height="316" rx="22" fill="#ffffff"/>
  <g transform="translate(58 116)" stroke="#D3E3FD" stroke-width="3">
    <rect width="86" height="72" rx="14" fill="#E8F0FE"/>
    <rect x="108" width="86" height="72" rx="14" fill="#F7FAFF"/>
    <rect x="216" width="86" height="72" rx="14" fill="#E8F0FE"/>
    <rect y="92" width="86" height="72" rx="14" fill="#F7FAFF"/>
    <rect x="108" y="92" width="86" height="72" rx="14" fill="#D3E3FD" fill-opacity="0.45"/>
    <rect x="216" y="92" width="86" height="72" rx="14" fill="#F7FAFF"/>
    <rect y="184" width="86" height="72" rx="14" fill="#E8F0FE"/>
    <rect x="108" y="184" width="86" height="72" rx="14" fill="#F7FAFF"/>
    <rect x="216" y="184" width="86" height="72" rx="14" fill="#E8F0FE"/>
  </g>
  <circle cx="101" cy="152" r="18" fill="#0B57D0"/>
  <circle cx="209" cy="152" r="18" fill="#A8C7FA"/>
  <circle cx="317" cy="152" r="18" fill="#4285F4"/>
  <circle cx="101" cy="244" r="18" fill="#A8C7FA"/>
  <circle cx="209" cy="244" r="18" fill="#4285F4"/>
  <circle cx="317" cy="244" r="18" fill="#0B57D0"/>
  <circle cx="101" cy="336" r="18" fill="#4285F4"/>
  <circle cx="209" cy="336" r="18" fill="#0B57D0"/>
  <circle cx="317" cy="336" r="18" fill="#A8C7FA"/>
</svg>`);

const PPT_OUTLINE_IMAGE_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
  <rect width="420" height="420" rx="34" fill="#EDF2FB"/>
  <rect x="34" y="44" width="352" height="318" rx="22" fill="#ffffff"/>
  <rect x="34" y="44" width="352" height="52" rx="22" fill="#E8F0FE"/>
  <rect x="56" y="126" width="160" height="14" rx="7" fill="#0B57D0"/>
  <rect x="56" y="164" width="274" height="12" rx="6" fill="#D3E3FD"/>
  <rect x="56" y="192" width="220" height="12" rx="6" fill="#E8F0FE"/>
  <rect x="56" y="244" width="100" height="70" rx="12" fill="#F7FAFF" stroke="#A8C7FA"/>
  <rect x="186" y="244" width="100" height="70" rx="12" fill="#F7FAFF" stroke="#A8C7FA"/>
  <rect x="316" y="244" width="52" height="70" rx="12" fill="#F7FAFF" stroke="#A8C7FA"/>
  <circle cx="82" cy="279" r="14" fill="#0B57D0"/>
  <circle cx="236" cy="279" r="14" fill="#4285F4"/>
  <circle cx="342" cy="279" r="14" fill="#A8C7FA"/>
  <path d="M158 279h24M288 279h24" stroke="#C5C8D6" stroke-width="8" stroke-linecap="round"/>
  <rect x="56" y="334" width="312" height="10" rx="5" fill="#E8F0FE"/>
</svg>`);

const MINDMAP_IMAGE_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
  <rect width="420" height="420" rx="34" fill="#EDF2FB"/>
  <rect x="34" y="48" width="352" height="312" rx="22" fill="#ffffff"/>
  <g fill="none" stroke="#A8C7FA" stroke-width="3" stroke-linecap="round">
    <path d="M210 210C170 190 150 156 126 128"/>
    <path d="M210 210C170 220 144 252 116 286"/>
    <path d="M210 210C250 184 278 150 312 128"/>
    <path d="M210 210C252 224 280 254 322 292"/>
    <path d="M126 128C108 116 94 110 78 104"/>
    <path d="M312 128C332 116 346 110 362 104"/>
    <path d="M116 286C98 300 82 310 66 324"/>
    <path d="M322 292C342 302 356 312 372 326"/>
  </g>
  <rect x="168" y="178" width="84" height="64" rx="18" fill="#D3E3FD" stroke="#0B57D0" stroke-width="3"/>
  <circle cx="210" cy="210" r="16" fill="#0B57D0"/>
  <rect x="76" y="98" width="98" height="36" rx="13" fill="#F7FAFF" stroke="#C9DCF8"/>
  <rect x="72" y="270" width="102" height="36" rx="13" fill="#F7FAFF" stroke="#C9DCF8"/>
  <rect x="262" y="98" width="102" height="36" rx="13" fill="#F7FAFF" stroke="#C9DCF8"/>
  <rect x="266" y="276" width="108" height="36" rx="13" fill="#F7FAFF" stroke="#C9DCF8"/>
  <circle cx="96" cy="116" r="7" fill="#0B57D0"/>
  <circle cx="96" cy="288" r="7" fill="#4285F4"/>
  <circle cx="286" cy="116" r="7" fill="#A8C7FA"/>
  <circle cx="290" cy="294" r="7" fill="#0B57D0"/>
  <rect x="116" y="112" width="42" height="7" rx="3.5" fill="#D3E3FD"/>
  <rect x="116" y="284" width="44" height="7" rx="3.5" fill="#D3E3FD"/>
  <rect x="306" y="112" width="42" height="7" rx="3.5" fill="#D3E3FD"/>
  <rect x="310" y="290" width="46" height="7" rx="3.5" fill="#D3E3FD"/>
</svg>`);

/**
 * 预设灵感模版列表
 */
export const INSPIRATION_TEMPLATES: InspirationTemplate[] = [
  {
    id: 'grid-emoji',
    title: '智能拆分宫格图',
    description: '宫格图，风格统一',
    prompt: '生成16宫格猫咪表情包',
    category: InspirationCategory.GRID,
    imageUrl: GRID_IMAGE_URL,
    badgeColor: 'badge--grid',
    skillId: 'generate_grid_image',
  },
  {
    id: 'ppt-outline',
    title: '生成PPT大纲',
    description: '用参考图片规划配图与页面提示词',
    prompt:
      '生成一份关于「AI 创作工作流」的 PPT 大纲；如果已上传参考图片，请将参考图片作为配图和视觉风格参考。',
    category: InspirationCategory.PPT,
    imageUrl: PPT_OUTLINE_IMAGE_URL,
    badgeColor: 'badge--ppt',
    skillId: 'generate_ppt',
  },
  {
    id: 'mindmap-project',
    title: '项目规划脑图',
    description: '快速生成结构化的思维导图，梳理项目计划',
    prompt:
      '创建一个关于「移动应用开发」的思维导图，包含需求分析、UI设计、前端开发、后端开发、测试上线等主要分支',
    category: InspirationCategory.MINDMAP,
    imageUrl: MINDMAP_IMAGE_URL,
    badgeColor: 'badge--mindmap',
    skillId: 'generate_mindmap',
  },
];

/**
 * 分类对应的颜色配置
 */
/**
 * 分类对应的颜色配置
 *
 * 全部分类统一为品牌蓝 chip（M3 primary-container）：原先七分类七彩
 * （紫/蓝/绿/黄…），三张卡三个色系让首屏像「三个产品拼的」——统一后
 * 与主题强调色同族，画面成套。
 */
export const CATEGORY_COLORS: Record<
  InspirationCategory,
  { bg: string; text: string }
> = {
  [InspirationCategory.VIDEO]: { bg: '#D3E3FD', text: '#041E49' },
  [InspirationCategory.IMAGE]: { bg: '#D3E3FD', text: '#041E49' },
  [InspirationCategory.MINDMAP]: { bg: '#D3E3FD', text: '#041E49' },
  [InspirationCategory.FLOWCHART]: { bg: '#D3E3FD', text: '#041E49' },
  [InspirationCategory.PPT]: { bg: '#D3E3FD', text: '#041E49' },
  [InspirationCategory.GRID]: { bg: '#D3E3FD', text: '#041E49' },
  [InspirationCategory.SVG]: { bg: '#D3E3FD', text: '#041E49' },
};

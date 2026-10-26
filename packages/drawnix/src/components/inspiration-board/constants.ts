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
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 320">
  <rect width="420" height="320" rx="30" fill="#EDF2FB"/>
  <rect x="36" y="32" width="348" height="256" rx="20" fill="#ffffff"/>
  <g transform="translate(100 68)" stroke="#D3E3FD" stroke-width="2.5">
    <rect width="64" height="52" rx="12" fill="#E8F0FE"/>
    <rect x="78" width="64" height="52" rx="12" fill="#F7FAFF"/>
    <rect x="156" width="64" height="52" rx="12" fill="#E8F0FE"/>
    <rect y="66" width="64" height="52" rx="12" fill="#F7FAFF"/>
    <rect x="78" y="66" width="64" height="52" rx="12" fill="#D3E3FD" fill-opacity="0.5"/>
    <rect x="156" y="66" width="64" height="52" rx="12" fill="#F7FAFF"/>
    <rect y="132" width="64" height="52" rx="12" fill="#E8F0FE"/>
    <rect x="78" y="132" width="64" height="52" rx="12" fill="#F7FAFF"/>
    <rect x="156" y="132" width="64" height="52" rx="12" fill="#E8F0FE"/>
  </g>
  <circle cx="132" cy="94" r="11" fill="#0B57D0"/>
  <circle cx="210" cy="160" r="11" fill="#4285F4"/>
  <circle cx="288" cy="226" r="11" fill="#A8C7FA"/>
</svg>`);

const PPT_OUTLINE_IMAGE_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 320">
  <rect width="420" height="320" rx="30" fill="#EDF2FB"/>
  <rect x="34" y="32" width="352" height="256" rx="20" fill="#ffffff"/>
  <rect x="34" y="32" width="352" height="44" rx="20" fill="#E8F0FE"/>
  <rect x="56" y="96" width="150" height="13" rx="6.5" fill="#0B57D0"/>
  <rect x="56" y="126" width="252" height="11" rx="5.5" fill="#D3E3FD"/>
  <rect x="56" y="150" width="200" height="11" rx="5.5" fill="#E8F0FE"/>
  <rect x="56" y="190" width="92" height="62" rx="12" fill="#F7FAFF" stroke="#A8C7FA"/>
  <rect x="168" y="190" width="92" height="62" rx="12" fill="#F7FAFF" stroke="#A8C7FA"/>
  <rect x="280" y="190" width="52" height="62" rx="12" fill="#F7FAFF" stroke="#A8C7FA"/>
  <circle cx="80" cy="221" r="12" fill="#0B57D0"/>
  <circle cx="212" cy="221" r="12" fill="#4285F4"/>
  <circle cx="306" cy="221" r="12" fill="#A8C7FA"/>
  <path d="M150 221h16M262 221h16" stroke="#C5C8D6" stroke-width="7" stroke-linecap="round"/>
  <rect x="56" y="264" width="276" height="9" rx="4.5" fill="#E8F0FE"/>
</svg>`);

const MINDMAP_IMAGE_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 320">
  <rect width="420" height="320" rx="30" fill="#EDF2FB"/>
  <rect x="34" y="32" width="352" height="256" rx="20" fill="#ffffff"/>
  <g fill="none" stroke="#A8C7FA" stroke-width="2.5" stroke-linecap="round">
    <path d="M210 160C178 144 162 118 140 96"/>
    <path d="M210 160C180 170 158 192 138 220"/>
    <path d="M210 160C242 142 262 116 284 96"/>
    <path d="M210 160C244 174 268 196 290 222"/>
  </g>
  <rect x="176" y="134" width="68" height="52" rx="14" fill="#D3E3FD" stroke="#0B57D0" stroke-width="2.5"/>
  <circle cx="210" cy="160" r="12" fill="#0B57D0"/>
  <rect x="86" y="78" width="88" height="32" rx="11" fill="#F7FAFF" stroke="#C9DCF8"/>
  <rect x="86" y="210" width="92" height="32" rx="11" fill="#F7FAFF" stroke="#C9DCF8"/>
  <rect x="282" y="78" width="92" height="32" rx="11" fill="#F7FAFF" stroke="#C9DCF8"/>
  <rect x="278" y="212" width="98" height="32" rx="11" fill="#F7FAFF" stroke="#C9DCF8"/>
  <circle cx="104" cy="94" r="6" fill="#0B57D0"/>
  <circle cx="104" cy="226" r="6" fill="#4285F4"/>
  <circle cx="300" cy="94" r="6" fill="#A8C7FA"/>
  <circle cx="296" cy="228" r="6" fill="#0B57D0"/>
  <rect x="120" y="90" width="38" height="6" rx="3" fill="#D3E3FD"/>
  <rect x="120" y="222" width="40" height="6" rx="3" fill="#D3E3FD"/>
  <rect x="314" y="90" width="38" height="6" rx="3" fill="#D3E3FD"/>
  <rect x="318" y="224" width="42" height="6" rx="3" fill="#D3E3FD"/>
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

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
  <rect width="420" height="320" rx="30" fill="#E9F0FC"/>
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
  <rect width="420" height="320" rx="30" fill="#FEF7E0"/>
  <rect x="34" y="32" width="352" height="256" rx="20" fill="#ffffff"/>
  <rect x="34" y="32" width="352" height="44" rx="20" fill="#FEEFC3"/>
  <rect x="56" y="96" width="150" height="13" rx="6.5" fill="#E37400"/>
  <rect x="56" y="126" width="252" height="11" rx="5.5" fill="#FEEFC3"/>
  <rect x="56" y="150" width="200" height="11" rx="5.5" fill="#FEF7E0"/>
  <rect x="56" y="190" width="92" height="62" rx="12" fill="#FFFDF5" stroke="#F9AB00"/>
  <rect x="168" y="190" width="92" height="62" rx="12" fill="#FFFDF5" stroke="#F9AB00"/>
  <rect x="280" y="190" width="52" height="62" rx="12" fill="#FFFDF5" stroke="#F9AB00"/>
  <circle cx="80" cy="221" r="12" fill="#E37400"/>
  <circle cx="212" cy="221" r="12" fill="#F9AB00"/>
  <circle cx="306" cy="221" r="12" fill="#FEEFC3"/>
  <path d="M150 221h16M262 221h16" stroke="#C5C8D6" stroke-width="7" stroke-linecap="round"/>
  <rect x="56" y="264" width="276" height="9" rx="4.5" fill="#FEEFC3"/>
</svg>`);

const MINDMAP_IMAGE_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 320">
  <rect width="420" height="320" rx="30" fill="#E6F4EA"/>
  <rect x="34" y="32" width="352" height="256" rx="20" fill="#ffffff"/>
  <g fill="none" stroke="#81C995" stroke-width="2.5" stroke-linecap="round">
    <path d="M210 160C178 144 162 118 140 96"/>
    <path d="M210 160C180 170 158 192 138 220"/>
    <path d="M210 160C242 142 262 116 284 96"/>
    <path d="M210 160C244 174 268 196 290 222"/>
  </g>
  <rect x="176" y="134" width="68" height="52" rx="14" fill="#CEEAD6" stroke="#188038" stroke-width="2.5"/>
  <circle cx="210" cy="160" r="12" fill="#188038"/>
  <rect x="86" y="78" width="88" height="32" rx="11" fill="#F5FBF7" stroke="#A8DAB5"/>
  <rect x="86" y="210" width="92" height="32" rx="11" fill="#F5FBF7" stroke="#A8DAB5"/>
  <rect x="282" y="78" width="92" height="32" rx="11" fill="#F5FBF7" stroke="#A8DAB5"/>
  <rect x="278" y="212" width="98" height="32" rx="11" fill="#F5FBF7" stroke="#A8DAB5"/>
  <circle cx="104" cy="94" r="6" fill="#188038"/>
  <circle cx="104" cy="226" r="6" fill="#34A853"/>
  <circle cx="300" cy="94" r="6" fill="#81C995"/>
  <circle cx="296" cy="228" r="6" fill="#188038"/>
  <rect x="120" y="90" width="38" height="6" rx="3" fill="#CEEAD6"/>
  <rect x="120" y="222" width="40" height="6" rx="3" fill="#CEEAD6"/>
  <rect x="314" y="90" width="38" height="6" rx="3" fill="#CEEAD6"/>
  <rect x="318" y="224" width="42" height="6" rx="3" fill="#CEEAD6"/>
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
 * 分类对应的颜色配置（MD3 色调容器体系）
 *
 * 每个分类一个色相的「container 底 + on-container 文字」，与 Google
 * Workspace 的蓝/绿/黄/红容器同族；插画用同色相的 tint/accent/mid
 * 成套绘制（chip 色相 = 插画色相），表面仍保持中性——多彩但成体系。
 */
export const CATEGORY_COLORS: Record<
  InspirationCategory,
  { bg: string; text: string; accent: string; mid: string; tint: string }
> = {
  // 蓝（primary-container 同族）
  [InspirationCategory.GRID]: {
    bg: '#D3E3FD',
    text: '#041E49',
    accent: '#0B57D0',
    mid: '#A8C7FA',
    tint: '#E9F0FC',
  },
  // 琥珀
  [InspirationCategory.PPT]: {
    bg: '#FEEFC3',
    text: '#715100',
    accent: '#E37400',
    mid: '#F9AB00',
    tint: '#FEF7E0',
  },
  // 绿
  [InspirationCategory.MINDMAP]: {
    bg: '#CEEAD6',
    text: '#0D652D',
    accent: '#188038',
    mid: '#81C995',
    tint: '#E6F4EA',
  },
  // 红
  [InspirationCategory.VIDEO]: {
    bg: '#FCE8E6',
    text: '#C5221F',
    accent: '#D93025',
    mid: '#F28B82',
    tint: '#FDECEA',
  },
  // 紫
  [InspirationCategory.IMAGE]: {
    bg: '#E9DDFF',
    text: '#3F1D6E',
    accent: '#7248B9',
    mid: '#A585E8',
    tint: '#F1EBFF',
  },
  // 青
  [InspirationCategory.FLOWCHART]: {
    bg: '#CDE9E5',
    text: '#0B5C54',
    accent: '#0E8A7D',
    mid: '#5FB8AC',
    tint: '#E5F4F1',
  },
  // 粉
  [InspirationCategory.SVG]: {
    bg: '#FCE0EE',
    text: '#A1125C',
    accent: '#D3307F',
    mid: '#F08CC0',
    tint: '#FDEBF5',
  },
};

/**
 * 图标体系（Lucide 系列：圆润线条风，与输入栏 Send/Chevron 等既有图标同源）
 *
 * - 通用图标：lucide-react（stroke 风格、继承 currentColor），以本文件原有
 *   组件名导出（含 size 默认值），调用方零改动
 * - 个别工具语义 lucide 无对应图形（平行四边形/圆角矩形）→ 自绘 SVG
 * - 保留原实现：选择器色板（描边样式/颜色拾取，语义 swatch 非通用图标）
 *   与品牌 logo（GitHub/WeCom/Mermaid/Markdown）
 */
import React from 'react';
import {
  AlignCenterHorizontal as Lucide_AlignCenterHorizontal,
  AlignCenterVertical as Lucide_AlignCenterVertical,
  AlignEndHorizontal as Lucide_AlignEndHorizontal,
  AlignEndVertical as Lucide_AlignEndVertical,
  AlignHorizontalJustifyCenter as Lucide_AlignHorizontalJustifyCenter,
  AlignHorizontalSpaceAround as Lucide_AlignHorizontalSpaceAround,
  AlignStartHorizontal as Lucide_AlignStartHorizontal,
  AlignStartVertical as Lucide_AlignStartVertical,
  AlignVerticalJustifyCenter as Lucide_AlignVerticalJustifyCenter,
  AlignVerticalSpaceAround as Lucide_AlignVerticalSpaceAround,
  ArrowUpRight as Lucide_ArrowUpRight,
  Blend as Lucide_Blend,
  BookOpen as Lucide_BookOpen,
  BringToFront as Lucide_BringToFront,
  Brush as Lucide_Brush,
  Bug as Lucide_Bug,
  ChevronsDown as Lucide_ChevronsDown,
  ChevronsUp as Lucide_ChevronsUp,
  Circle as Lucide_Circle,
  CirclePlus as Lucide_CirclePlus,
  CircleSlash as Lucide_CircleSlash,
  Cloud as Lucide_Cloud,
  Combine as Lucide_Combine,
  Command as Lucide_Command,
  Contrast as Lucide_Contrast,
  Copy as Lucide_Copy,
  CopyPlus as Lucide_CopyPlus,
  CornerUpRight as Lucide_CornerUpRight,
  Crosshair as Lucide_Crosshair,
  DatabaseBackup as Lucide_DatabaseBackup,
  Diamond as Lucide_Diamond,
  Download as Lucide_Download,
  Eraser as Lucide_Eraser,
  Eye as Lucide_Eye,
  Film as Lucide_Film,
  Filter as Lucide_Filter,
  FoldVertical as Lucide_FoldVertical,
  Folder as Lucide_Folder,
  FolderOpen as Lucide_FolderOpen,
  Frame as Lucide_Frame,
  Grid2x2 as Lucide_Grid2x2,
  Hand as Lucide_Hand,
  Image as Lucide_Image,
  ImageDown as Lucide_ImageDown,
  ImagePlus as Lucide_ImagePlus,
  Lasso as Lucide_Lasso,
  Layers as Lucide_Layers,
  LayoutDashboard as Lucide_LayoutDashboard,
  LayoutTemplate as Lucide_LayoutTemplate,
  Link2 as Lucide_Link2,
  Link2Off as Lucide_Link2Off,
  ListTodo as Lucide_ListTodo,
  Lock as Lucide_Lock,
  LockOpen as Lucide_LockOpen,
  Megaphone as Lucide_Megaphone,
  Menu as Lucide_Menu,
  Merge as Lucide_Merge,
  MessageSquare as Lucide_MessageSquare,
  Minus as Lucide_Minus,
  MoreHorizontal as Lucide_MoreHorizontal,
  MousePointer2 as Lucide_MousePointer2,
  Network as Lucide_Network,
  PaintBucket as Lucide_PaintBucket,
  Paintbrush as Lucide_Paintbrush,
  PenLine as Lucide_PenLine,
  PenTool as Lucide_PenTool,
  PersonStanding as Lucide_PersonStanding,
  Redo2 as Lucide_Redo2,
  Save as Lucide_Save,
  SendToBack as Lucide_SendToBack,
  Settings as Lucide_Settings,
  Shapes as Lucide_Shapes,
  Slash as Lucide_Slash,
  SlidersHorizontal as Lucide_SlidersHorizontal,
  Sparkles as Lucide_Sparkles,
  Spline as Lucide_Spline,
  Split as Lucide_Split,
  Square as Lucide_Square,
  SquarePen as Lucide_SquarePen,
  Terminal as Lucide_Terminal,
  Trash2 as Lucide_Trash2,
  Triangle as Lucide_Triangle,
  Type as Lucide_Type,
  Undo2 as Lucide_Undo2,
  Video as Lucide_Video,
  Waypoints as Lucide_Waypoints,
  ZoomIn as Lucide_ZoomIn,
  ZoomOut as Lucide_ZoomOut,
} from 'lucide-react';

export const createIcon = (svg: React.ReactNode) => {
  return svg;
};

type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };

/** lucide 图标 → 原有图标组件形态（size 默认值可覆写） */
const lucide =
  (L: React.ComponentType<any>, defaultSize = 24): React.FC<IconProps> =>
  ({ size = defaultSize, ...rest }) =>
    <L size={size} {...(rest as Record<string, unknown>)} />;

export const HandIcon = lucide(Lucide_Hand);
export const SelectionIcon = lucide(Lucide_MousePointer2);
export const MindIcon = lucide(Lucide_Network);
export const FolderIcon = lucide(Lucide_Folder);
export const ToolboxIcon = lucide(Lucide_Grid2x2);
export const TaskIcon = lucide(Lucide_ListTodo);
export const ShapeIcon = lucide(Lucide_Shapes);
export const TextIcon = lucide(Lucide_Type);
export const EraseIcon = lucide(Lucide_Eraser);
export const StraightArrowLineIcon = lucide(Lucide_Slash);
export const RectangleIcon = lucide(Lucide_Square);
export const TerminalIcon = lucide(Lucide_Terminal);
export const EllipseIcon = lucide(Lucide_Circle);
export const TriangleIcon = lucide(Lucide_Triangle);
export const DiamondIcon = lucide(Lucide_Diamond);
export const StraightArrowIcon = lucide(Lucide_ArrowUpRight);
export const ElbowArrowIcon = lucide(Lucide_CornerUpRight);
export const CurveArrowIcon = lucide(Lucide_Spline);
export const MenuIcon = lucide(Lucide_Menu);
export const AIImageIcon = lucide(Lucide_Image);
export const AIVideoIcon = lucide(Lucide_Video);
export const ExportImageIcon = lucide(Lucide_ImageDown);
export const ZoomOutIcon = lucide(Lucide_ZoomOut, 16);
export const ZoomInIcon = lucide(Lucide_ZoomIn, 16);
export const SaveFileIcon = lucide(Lucide_Save);
export const OpenFileIcon = lucide(Lucide_FolderOpen, 18);
export const UndoIcon = lucide(Lucide_Undo2, 16);
export const RedoIcon = lucide(Lucide_Redo2, 16);
export const TrashIcon = lucide(Lucide_Trash2);
export const DuplicateIcon = lucide(Lucide_Copy);
export const FeltTipPenIcon = lucide(Lucide_Brush);
export const MaskBrushIcon = lucide(Lucide_Paintbrush);
export const LaserPointerIcon = lucide(Lucide_Crosshair);
export const VectorPenIcon = lucide(Lucide_PenTool);
export const AnchorCornerIcon = lucide(Lucide_PenLine);
export const AnchorSmoothIcon = lucide(Lucide_Spline);
export const AnchorSymmetricIcon = lucide(Lucide_Waypoints);
export const ImageIcon = lucide(Lucide_Image);
export const ImageUploadIcon = lucide(Lucide_ImagePlus);
export const LinkIcon = lucide(Lucide_Link2, 16);
export const SettingsIcon = lucide(Lucide_Settings);
export const VideoFrameIcon = lucide(Lucide_Film);
export const TemplateGalleryIcon = lucide(Lucide_LayoutTemplate);
export const MediaLibraryIcon = lucide(Lucide_ImagePlus);
export const ViewIcon = lucide(Lucide_Eye);
export const ThemeIcon = lucide(Lucide_Contrast);
export const MoreIcon = lucide(Lucide_MoreHorizontal);
export const SplitImageIcon = lucide(Lucide_Split);
export const DownloadIcon = lucide(Lucide_Download);
export const MergeIcon = lucide(Lucide_Merge);
export const VideoMergeIcon = lucide(Lucide_Combine);
export const ImageEditIcon = lucide(Lucide_Filter);
export const FontFamilyIcon = lucide(Lucide_Type);
export const ShadowEffectIcon = lucide(Lucide_Blend);
export const GradientIcon = lucide(Lucide_PaintBucket);
export const LayerIcon = lucide(Lucide_Layers);
export const BringToFrontIcon = lucide(Lucide_BringToFront);
export const BringForwardIcon = lucide(Lucide_ChevronsUp);
export const SendBackwardIcon = lucide(Lucide_ChevronsDown);
export const SendToBackIcon = lucide(Lucide_SendToBack);
export const PropertySettingsIcon = lucide(Lucide_SlidersHorizontal);
export const BackupRestoreIcon = lucide(Lucide_DatabaseBackup);
export const LockIcon = lucide(Lucide_Lock);
export const UnlockIcon = lucide(Lucide_LockOpen);
export const PromptIcon = lucide(Lucide_SquarePen);
export const PoseIcon = lucide(Lucide_PersonStanding);
export const MessageIcon = lucide(Lucide_MessageSquare);
export const FeedbacklandIcon = lucide(Lucide_Megaphone);
export const BatchIcon = lucide(Lucide_CopyPlus);
export const InsertToCanvasIcon = lucide(Lucide_CirclePlus);
export const DebugLogIcon = lucide(Lucide_Bug);
export const CommandPaletteIcon = lucide(Lucide_Command);
export const BookOpenIcon = lucide(Lucide_BookOpen);
export const AlignmentIcon = lucide(Lucide_AlignHorizontalJustifyCenter);
export const AlignLeftIcon = lucide(Lucide_AlignStartVertical);
export const AlignCenterIcon = lucide(Lucide_AlignCenterVertical);
export const AlignRightIcon = lucide(Lucide_AlignEndVertical);
export const AlignTopIcon = lucide(Lucide_AlignStartHorizontal);
export const AlignMiddleIcon = lucide(Lucide_AlignCenterHorizontal);
export const AlignBottomIcon = lucide(Lucide_AlignEndHorizontal);
export const DistributeIcon = lucide(Lucide_AlignVerticalJustifyCenter);
export const DistributeHorizontalIcon = lucide(Lucide_AlignHorizontalSpaceAround);
export const DistributeVerticalIcon = lucide(Lucide_AlignVerticalSpaceAround);
export const AutoArrangeIcon = lucide(Lucide_LayoutDashboard);
export const BooleanIcon = lucide(Lucide_Combine);
export const BooleanUnionIcon = lucide(Lucide_Combine);
export const BooleanSubtractIcon = lucide(Lucide_Minus);
export const BooleanIntersectIcon = lucide(Lucide_Layers);
export const BooleanExcludeIcon = lucide(Lucide_CircleSlash);
export const BooleanFlattenIcon = lucide(Lucide_FoldVertical);
export const CloudIcon = lucide(Lucide_Cloud);
export const CleanBrokenLinksIcon = lucide(Lucide_Link2Off);
export const FrameContainerIcon = lucide(Lucide_Frame);
export const LassoIcon = lucide(Lucide_Lasso);
export const WandIcon = lucide(Lucide_Sparkles);

/** 平行四边形：lucide 无对应图形，自绘 */
export const ParallelogramIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    width={size}
    height={size}
    {...props}
  >
    <path d="M8 5h13l-3 14H5L8 5z" />
  </svg>
);

/** 圆角矩形：lucide 无对应图形，自绘 */
export const RoundRectangleIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    width={size}
    height={size}
    {...props}
  >
    <rect x="3" y="5" width="18" height="14" rx="4" />
  </svg>
);

export const GithubIcon: React.FC<IconProps> = ({ size = 20, ...props }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width={size} height={size} {...props}>
    <path
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      d="M7.5 15.833c-3.583 1.167-3.583-2.083-5-2.5m10 4.167v-2.917c0-.833.083-1.166-.417-1.666 2.334-.25 4.584-1.167 4.584-5a3.833 3.833 0 0 0-1.084-2.667 3.5 3.5 0 0 0-.083-2.667s-.917-.25-2.917 1.084a10.25 10.25 0 0 0-5.166 0C5.417 2.333 4.5 2.583 4.5 2.583a3.5 3.5 0 0 0-.083 2.667 3.833 3.833 0 0 0-1.084 2.667c0 3.833 2.25 4.75 4.584 5-.5.5-.5 1-.417 1.666V17.5"
      strokeWidth="1.25"
    ></path>
  </svg>
);

export const MermaidLogoIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width={size} height={size} {...props}>
    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
  </svg>
);

export const MarkdownLogoIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width={size} height={size} {...props}>
    <rect width="20" height="16" x="2" y="4" rx="2" />
    <path d="M7 15V9l3 3 3-3v6M17 15l2-2-2-2M19 13h-4" />
  </svg>
);

export const WeComIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width={size} height={size} {...props}>
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    <path d="M8 12h.01" />
    <path d="M12 12h.01" />
    <path d="M16 12h.01" />
  </svg>
);


export const BackgroundColorIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    className="background-color-icon"
    width={size}
    height={size}
    {...props}
  >
    <g transform="translate(1 1)" fillRule="evenodd" fill="#000" stroke="none">
      <circle fillOpacity=".04" r="11" cy="11" cx="11"></circle>
      <path
        d="M17 20.221V17h3.221A11.06 11.06 0 0 1 17 20.221zm-12 0A11.06 11.06 0 0 1 1.779 17H5v3.221zM20.221 5H17V1.779A11.06 11.06 0 0 1 20.221 5zM9 .181V1H6.411A10.919 10.919 0 0 1 9 .181zM15.589 1H13V.181c.907.167 1.775.445 2.589.819zM13 21.819V21h2.589c-.814.374-1.682.652-2.589.819zm-4 0A10.919 10.919 0 0 1 6.411 21H9v.819zm-8-6.23A10.919 10.919 0 0 1 .181 13H1v2.589zm0-9.178V9H.181C.348 8.093.626 7.225 1 6.411zM21.819 9H21V6.411c.374.814.652 1.682.819 2.589zM21 15.589V13h.819A10.919 10.919 0 0 1 21 15.589zM5 1.779V5H1.779A11.06 11.06 0 0 1 5 1.779zM5 13h4v4H5v-4zm8 0h4v4h-4v-4zM5 5h4v4H5V5zm8 0h4v4h-4V5zm0 12v4H9v-4h4zm8-8v4h-4V9h4zm-8 0v4H9V9h4zM5 9v4H1V9h4zm8-8v4H9V1h4z"
        fillOpacity=".12"
      ></path>
    </g>
  </svg>
);

export const NoColorIcon: React.FC<IconProps> = ({ size = 32, ...props }) => (
  <svg viewBox="0 0 32 32" className="no-color-icon" width={size} height={size} {...props}>
    <g xmlns="http://www.w3.org/2000/svg" fillRule="nonzero" fill="currentColor" stroke="none">
      <path d="M2 16c0 7.733 6.267 14 14 14s14-6.267 14-14S23.733 2 16 2 2 8.267 2 16zm-1 0C1 7.716 7.714 1 16 1c8.284 0 15 6.714 15 15 0 8.284-6.714 15-15 15-8.284 0-15-6.714-15-15z"></path>
      <path d="M6.354 26.354l-.708-.708 20-20 .708.708z"></path>
    </g>
  </svg>
);

export const Check: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg className="selected-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={size} height={size} {...props}>
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

export const StrokeIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg viewBox="0 0 24 24" className="stroke-icon" width={size} height={size} {...props}>
    <g xmlns="http://www.w3.org/2000/svg" stroke="none" fillRule="evenodd" fill="#000">
      <path
        d="M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm0-4c6.075 0 11 4.925 11 11s-4.925 11-11 11S1 18.075 1 12 5.925 1 12 1z"
        fillRule="nonzero"
        fillOpacity=".04"
      ></path>
      <path
        d="M12 5V1c1.491 0 2.914.297 4.21.835L14.68 5.53A6.979 6.979 0 0 0 12 5zm4.95 2.048l2.828-2.828a11.016 11.016 0 0 1 2.388 3.568l-3.697 1.53a7.01 7.01 0 0 0-1.519-2.27zM19 12h4c0 1.491-.297 2.914-.835 4.21l-3.696-1.53c.342-.826.531-1.73.531-2.68zm-2.05 4.95l2.828 2.828a11.016 11.016 0 0 1-3.567 2.387l-1.532-3.696a7.01 7.01 0 0 0 2.27-1.52zM12 19v4c-1.491 0-2.914-.297-4.21-.835l1.53-3.696c.826.342 1.73.531 2.68.531zm-4.95-2.05l-2.828 2.828a11.016 11.016 0 0 1-2.387-3.567l3.696-1.532a7.01 7.01 0 0 0 1.52 2.27zM5 12H1c0-1.491.297-2.914.835-4.21L5.53 9.32A6.979 6.979 0 0 0 5 12zm2.05-4.95L4.222 4.222a11.016 11.016 0 0 1 3.567-2.387L9.321 5.53a7.01 7.01 0 0 0-2.27 1.52z"
        fillOpacity=".12"
      ></path>
    </g>
  </svg>
);

export const StrokeWhiteIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...props}>
    <g xmlns="http://www.w3.org/2000/svg" id="icon-border-white" stroke="none" strokeWidth="1" fill="none" fillRule="evenodd" opacity="0.1">
      <g id="Group">
        <path
          d="M12,22 C17.5228475,22 22,17.5228475 22,12 C22,6.4771525 17.5228475,2 12,2 C6.4771525,2 2,6.4771525 2,12 C2,17.5228475 6.4771525,22 12,22 Z M12,23 C5.92486775,23 1,18.0751322 1,12 C1,5.92486775 5.92486775,1 12,1 C18.0751322,1 23,5.92486775 23,12 C23,18.0751322 18.0751322,23 12,23 Z"
          fill="#000000"
          fillRule="nonzero"
        />
        <path
          d="M12,19 C15.8659932,19 19,15.8659932 19,12 C19,8.13400675 15.8659932,5 12,5 C8.13400675,5 5,8.13400675 5,12 C5,15.8659932 8.13400675,19 12,19 Z M12,20 C7.581722,20 4,16.418278 4,12 C4,7.581722 7.581722,4 12,4 C16.418278,4 20,7.581722 20,12 C20,16.418278 16.418278,20 12,20 Z"
          fill="#000000"
          fillRule="nonzero"
        />
      </g>
    </g>
  </svg>
);

export const StrokeStyleNormalIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg" width={size} height={size} {...props}>
    <g transform="translate(0 14)" fillRule="evenodd" fill="none">
      <path d="M-18-19h60v40h-60z"></path>
      <path d="M0 0h24v2H0z" fill="currentColor"></path>
    </g>
  </svg>
);

export const StrokeStyleDashedIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg" width={size} height={size} {...props}>
    <g transform="translate(0 14)" fillRule="evenodd" fill="none">
      <g fill="currentColor">
        <path d="M0 0h6v2H0zM9 0h6v2H9zM18 0h6v2h-6z"></path>
      </g>
    </g>
  </svg>
);

export const StrokeStyleDotedIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg" width={size} height={size} {...props}>
    <g transform="translate(0 14)" fillRule="evenodd" fill="none">
      <g fill="currentColor">
        <rect rx="1" height="2" width="2"></rect>
        <rect rx="1" x="4" height="2" width="2"></rect>
        <rect rx="1" x="8" height="2" width="2"></rect>
        <rect rx="1" x="12" height="2" width="2"></rect>
        <rect rx="1" x="16" height="2" width="2"></rect>
        <rect rx="1" x="20" height="2" width="2"></rect>
      </g>
    </g>
  </svg>
);

export const StrokeStyleDoubleIcon: React.FC<IconProps> = ({ size = 24, ...props }) => (
  <svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg" width={size} height={size} {...props}>
    <g transform="translate(0 12)" fillRule="evenodd" fill="none">
      <path d="M0 0h24v2H0z" fill="currentColor"></path>
      <path d="M0 4h24v2H0z" fill="currentColor"></path>
    </g>
  </svg>
);

export const FontColorIcon: React.FC<{ currentColor?: string }> = ({
  currentColor,
}) => {
  return (
    <svg
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      className="font-color-icon"
    >
      <g
        id="font-color"
        strokeWidth="1"
        fillRule="evenodd"
        stroke="none"
        fill="currentColor"
      >
        <path
          id="secondary-color"
          d="M1.999 15.011h11.998V13.81H1.999z"
          fill={currentColor || '#333333'}
        ></path>
        <path
          d="M6.034 7.59h4.104L8.086 2.297 6.034 7.59zm-.465 1.2l-1.437 3.707H2.845L7.301 1h1.287l-.001.004h.286l4.454 11.492h-1.288L10.603 8.79H5.569z"
          id="A"
        ></path>
      </g>
    </svg>
  );
};

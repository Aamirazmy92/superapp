import { forwardRef, type ComponentType, type ForwardRefExoticComponent, type RefAttributes, type SVGProps } from 'react';
import {
  AlertCircle as LuAlertCircle,
  Archive as LuArchive,
  ArchiveRestore as LuArchiveRestore,
  ArrowDown as LuArrowDown,
  ArrowDownToLine as LuArrowDownToLine,
  ArrowLeft as LuArrowLeft,
  ArrowRight as LuArrowRight,
  ArrowUp as LuArrowUp,
  Bell as LuBell,
  Bookmark as LuBookmark,
  Check as LuCheck,
  CheckCheck as LuCheckCheck,
  ChevronDown as LuChevronDown,
  ChevronLeft as LuChevronLeft,
  ChevronRight as LuChevronRight,
  ChevronsDownUp as LuChevronsDownUp,
  ChevronsUpDown as LuChevronsUpDown,
  Circle as LuCircle,
  CircleDot as LuCircleDot,
  Code2 as LuCode2,
  Command as LuCommand,
  Copy as LuCopy,
  CornerDownLeft as LuCornerDownLeft,
  Download as LuDownload,
  ExternalLink as LuExternalLink,
  FileCode2 as LuFileCode2,
  FileDiff as LuFileDiff,
  FileJson as LuFileJson,
  FileMinus as LuFileMinus,
  FilePen as LuFilePen,
  FilePlus as LuFilePlus,
  FilePlus2 as LuFilePlus2,
  Files as LuFiles,
  FileText as LuFileText,
  Folder as LuFolder,
  FolderInput as LuFolderInput,
  FolderOpen as LuFolderOpen,
  FolderPlus as LuFolderPlus,
  GitBranch as LuGitBranch,
  Globe as LuGlobe,
  History as LuHistory,
  ImagePlus as LuImagePlus,
  Info as LuInfo,
  Keyboard as LuKeyboard,
  LayoutDashboard as LuLayoutDashboard,
  ListFilter as LuListFilter,
  Loader2 as LuLoader2,
  LoaderCircle as LuLoaderCircle,
  Maximize2 as LuMaximize2,
  MessageSquare as LuMessageSquare,
  Mic as LuMic,
  Minimize2 as LuMinimize2,
  Minus as LuMinus,
  Monitor as LuMonitor,
  MoreHorizontal as LuMoreHorizontal,
  MousePointerClick as LuMousePointerClick,
  PanelBottom as LuPanelBottom,
  PanelLeft as LuPanelLeft,
  PanelsTopLeft as LuPanelsTopLeft,
  Paperclip as LuPaperclip,
  Pencil as LuPencil,
  Pin as LuPin,
  PinOff as LuPinOff,
  Play as LuPlay,
  Plus as LuPlus,
  Radio as LuRadio,
  Redo2 as LuRedo2,
  RefreshCw as LuRefreshCw,
  RotateCcw as LuRotateCcw,
  SaveAll as LuSaveAll,
  Search as LuSearch,
  Settings2 as LuSettings2,
  ShieldAlert as LuShieldAlert,
  ShieldCheck as LuShieldCheck,
  SlidersHorizontal as LuSlidersHorizontal,
  Smartphone as LuSmartphone,
  Sparkles as LuSparkles,
  Square as LuSquare,
  SquarePen as LuSquarePen,
  SquareTerminal as LuSquareTerminal,
  Tablet as LuTablet,
  Trash2 as LuTrash2,
  Undo2 as LuUndo2,
  Volume2 as LuVolume2,
  VolumeX as LuVolumeX,
  WrapText as LuWrapText,
  X as LuX,
  Zap as LuZap,
  Settings as LuSettings,
  UserCog as LuUserCog,
} from 'lucide-react';

// The app's icon set: Lucide's thin, rounded 1.5px line icons, which sit closest to Claude's
// and ChatGPT's own (proprietary) sets. Components keep the names and the size / strokeWidth props the call sites use.
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {
  size?: number | string;
  strokeWidth?: number | string;
  weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
};
export type Icon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

type LucideGlyph = ComponentType<Record<string, unknown>>;

function adapt(Glyph: LucideGlyph, name: string): Icon {
  const Component = forwardRef<SVGSVGElement, IconProps>(function IconComponent(
    { size = 16, strokeWidth = 1.5, weight, ...rest },
    ref,
  ) {
    return (
      <Glyph
        ref={ref}
        size={size}
        strokeWidth={strokeWidth}
        {...(weight === 'fill' ? { fill: 'currentColor' } : {})}
        {...rest}
      />
    );
  });
  Component.displayName = name;
  return Component;
}

export const AlertCircle = adapt(LuAlertCircle as unknown as LucideGlyph, 'AlertCircle');
export const Archive = adapt(LuArchive as unknown as LucideGlyph, 'Archive');
export const ArchiveRestore = adapt(LuArchiveRestore as unknown as LucideGlyph, 'ArchiveRestore');
export const ArrowDown = adapt(LuArrowDown as unknown as LucideGlyph, 'ArrowDown');
export const ArrowDownToLine = adapt(LuArrowDownToLine as unknown as LucideGlyph, 'ArrowDownToLine');
export const ArrowLeft = adapt(LuArrowLeft as unknown as LucideGlyph, 'ArrowLeft');
export const ArrowRight = adapt(LuArrowRight as unknown as LucideGlyph, 'ArrowRight');
export const ArrowUp = adapt(LuArrowUp as unknown as LucideGlyph, 'ArrowUp');
export const Bell = adapt(LuBell as unknown as LucideGlyph, 'Bell');
export const Bookmark = adapt(LuBookmark as unknown as LucideGlyph, 'Bookmark');
export const Check = adapt(LuCheck as unknown as LucideGlyph, 'Check');
export const CheckCheck = adapt(LuCheckCheck as unknown as LucideGlyph, 'CheckCheck');
export const ChevronDown = adapt(LuChevronDown as unknown as LucideGlyph, 'ChevronDown');
export const ChevronLeft = adapt(LuChevronLeft as unknown as LucideGlyph, 'ChevronLeft');
export const ChevronRight = adapt(LuChevronRight as unknown as LucideGlyph, 'ChevronRight');
export const ChevronsDownUp = adapt(LuChevronsDownUp as unknown as LucideGlyph, 'ChevronsDownUp');
export const ChevronsUpDown = adapt(LuChevronsUpDown as unknown as LucideGlyph, 'ChevronsUpDown');
export const Circle = adapt(LuCircle as unknown as LucideGlyph, 'Circle');
export const CircleDot = adapt(LuCircleDot as unknown as LucideGlyph, 'CircleDot');
export const Code2 = adapt(LuCode2 as unknown as LucideGlyph, 'Code2');
export const Command = adapt(LuCommand as unknown as LucideGlyph, 'Command');
export const Copy = adapt(LuCopy as unknown as LucideGlyph, 'Copy');
export const CornerDownLeft = adapt(LuCornerDownLeft as unknown as LucideGlyph, 'CornerDownLeft');
export const Download = adapt(LuDownload as unknown as LucideGlyph, 'Download');
export const ExternalLink = adapt(LuExternalLink as unknown as LucideGlyph, 'ExternalLink');
export const FileCode2 = adapt(LuFileCode2 as unknown as LucideGlyph, 'FileCode2');
export const FileDiff = adapt(LuFileDiff as unknown as LucideGlyph, 'FileDiff');
export const FileJson = adapt(LuFileJson as unknown as LucideGlyph, 'FileJson');
export const FileMinus = adapt(LuFileMinus as unknown as LucideGlyph, 'FileMinus');
export const FilePen = adapt(LuFilePen as unknown as LucideGlyph, 'FilePen');
export const FilePlus = adapt(LuFilePlus as unknown as LucideGlyph, 'FilePlus');
export const FilePlus2 = adapt(LuFilePlus2 as unknown as LucideGlyph, 'FilePlus2');
export const Files = adapt(LuFiles as unknown as LucideGlyph, 'Files');
export const FileText = adapt(LuFileText as unknown as LucideGlyph, 'FileText');
export const Folder = adapt(LuFolder as unknown as LucideGlyph, 'Folder');
export const FolderInput = adapt(LuFolderInput as unknown as LucideGlyph, 'FolderInput');
export const FolderOpen = adapt(LuFolderOpen as unknown as LucideGlyph, 'FolderOpen');
export const FolderPlus = adapt(LuFolderPlus as unknown as LucideGlyph, 'FolderPlus');
export const GitBranch = adapt(LuGitBranch as unknown as LucideGlyph, 'GitBranch');
export const Globe = adapt(LuGlobe as unknown as LucideGlyph, 'Globe');
export const History = adapt(LuHistory as unknown as LucideGlyph, 'History');
export const ImagePlus = adapt(LuImagePlus as unknown as LucideGlyph, 'ImagePlus');
export const Info = adapt(LuInfo as unknown as LucideGlyph, 'Info');
export const Keyboard = adapt(LuKeyboard as unknown as LucideGlyph, 'Keyboard');
export const LayoutDashboard = adapt(LuLayoutDashboard as unknown as LucideGlyph, 'LayoutDashboard');
export const ListFilter = adapt(LuListFilter as unknown as LucideGlyph, 'ListFilter');
export const Loader2 = adapt(LuLoader2 as unknown as LucideGlyph, 'Loader2');
export const LoaderCircle = adapt(LuLoaderCircle as unknown as LucideGlyph, 'LoaderCircle');
export const Maximize2 = adapt(LuMaximize2 as unknown as LucideGlyph, 'Maximize2');
export const MessageSquare = adapt(LuMessageSquare as unknown as LucideGlyph, 'MessageSquare');
export const Mic = adapt(LuMic as unknown as LucideGlyph, 'Mic');
export const Minimize2 = adapt(LuMinimize2 as unknown as LucideGlyph, 'Minimize2');
export const Minus = adapt(LuMinus as unknown as LucideGlyph, 'Minus');
export const Monitor = adapt(LuMonitor as unknown as LucideGlyph, 'Monitor');
export const MoreHorizontal = adapt(LuMoreHorizontal as unknown as LucideGlyph, 'MoreHorizontal');
export const MousePointerClick = adapt(LuMousePointerClick as unknown as LucideGlyph, 'MousePointerClick');
export const PanelBottom = adapt(LuPanelBottom as unknown as LucideGlyph, 'PanelBottom');
export const PanelLeft = adapt(LuPanelLeft as unknown as LucideGlyph, 'PanelLeft');
export const PanelsTopLeft = adapt(LuPanelsTopLeft as unknown as LucideGlyph, 'PanelsTopLeft');
export const Paperclip = adapt(LuPaperclip as unknown as LucideGlyph, 'Paperclip');
export const Pencil = adapt(LuPencil as unknown as LucideGlyph, 'Pencil');
export const Pin = adapt(LuPin as unknown as LucideGlyph, 'Pin');
export const PinOff = adapt(LuPinOff as unknown as LucideGlyph, 'PinOff');
export const Play = adapt(LuPlay as unknown as LucideGlyph, 'Play');
export const Plus = adapt(LuPlus as unknown as LucideGlyph, 'Plus');
export const Radio = adapt(LuRadio as unknown as LucideGlyph, 'Radio');
export const Redo2 = adapt(LuRedo2 as unknown as LucideGlyph, 'Redo2');
export const RefreshCw = adapt(LuRefreshCw as unknown as LucideGlyph, 'RefreshCw');
export const RotateCcw = adapt(LuRotateCcw as unknown as LucideGlyph, 'RotateCcw');
export const SaveAll = adapt(LuSaveAll as unknown as LucideGlyph, 'SaveAll');
export const Search = adapt(LuSearch as unknown as LucideGlyph, 'Search');
export const Settings2 = adapt(LuSettings2 as unknown as LucideGlyph, 'Settings2');
export const ShieldAlert = adapt(LuShieldAlert as unknown as LucideGlyph, 'ShieldAlert');
export const ShieldCheck = adapt(LuShieldCheck as unknown as LucideGlyph, 'ShieldCheck');
export const SlidersHorizontal = adapt(LuSlidersHorizontal as unknown as LucideGlyph, 'SlidersHorizontal');
export const Smartphone = adapt(LuSmartphone as unknown as LucideGlyph, 'Smartphone');
export const Sparkles = adapt(LuSparkles as unknown as LucideGlyph, 'Sparkles');
export const Square = adapt(LuSquare as unknown as LucideGlyph, 'Square');
export const SquarePen = adapt(LuSquarePen as unknown as LucideGlyph, 'SquarePen');
export const SquareTerminal = adapt(LuSquareTerminal as unknown as LucideGlyph, 'SquareTerminal');
export const Tablet = adapt(LuTablet as unknown as LucideGlyph, 'Tablet');
export const Trash2 = adapt(LuTrash2 as unknown as LucideGlyph, 'Trash2');
export const Undo2 = adapt(LuUndo2 as unknown as LucideGlyph, 'Undo2');
export const Volume2 = adapt(LuVolume2 as unknown as LucideGlyph, 'Volume2');
export const VolumeX = adapt(LuVolumeX as unknown as LucideGlyph, 'VolumeX');
export const WrapText = adapt(LuWrapText as unknown as LucideGlyph, 'WrapText');
export const X = adapt(LuX as unknown as LucideGlyph, 'X');
export const Zap = adapt(LuZap as unknown as LucideGlyph, 'Zap');
// A plugin that needs an account or setup before it works.
export const UserSetup = adapt(LuUserCog as unknown as LucideGlyph, 'UserSetup');
// The gear used by the Settings buttons.
export const SettingsGear = adapt(LuSettings as unknown as LucideGlyph, 'SettingsGear');

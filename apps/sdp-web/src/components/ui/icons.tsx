import { forwardRef } from "react";
import {
  IconArrowLeftAndRightCircle,
  IconArrowClockwise,
  IconArrowDownLeft,
  IconArrowLeft,
  IconArrowTrianglehead2ClockwiseRotate90,
  IconArrowUpRight,
  IconBookClosed,
  IconBookPages,
  IconCheckmark,
  IconCheckmarkCircle,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconCircleFill,
  IconClock,
  IconDocumentOnDocument,
  IconDollarsign,
  IconDollarsignCircle,
  IconDrop,
  IconEllipsis,
  IconGamecontroller,
  IconGearshape2,
  IconHouse,
  IconKey,
  IconMagnifyingglass,
  IconPaperplane,
  IconPencil,
  IconPlay,
  IconPlus,
  IconQuestionmarkCircle,
  IconShieldLefthalfFilledBadgeCheckmark,
  IconShieldLefthalfFilledTrianglebadgeExclamationmark,
  IconSidebarLeft,
  IconSidebarRight,
  IconSparkles,
  type IconComponent as SymbolIconComponent,
  type IconProps as SymbolIconProps,
  IconSquareStack3dUp,
  IconKeyHorizontal,
  IconWalletBifold,
  IconWalletPass,
  IconXmark,
} from "symbols-react";

export type LucideIcon = SymbolIconComponent;
export type LucideProps = SymbolIconProps;

const DEFAULT_ICON_STROKE_WIDTH = 2.15;

function withIconDefaults(Icon: SymbolIconComponent): SymbolIconComponent {
  const WrappedIcon = forwardRef<SVGSVGElement, SymbolIconProps>(function WrappedIcon(
    {
      strokeWidth = DEFAULT_ICON_STROKE_WIDTH,
      strokeLinecap = "round",
      strokeLinejoin = "round",
      ...props
    },
    ref
  ) {
    return (
      <Icon
        ref={ref}
        strokeWidth={strokeWidth}
        strokeLinecap={strokeLinecap}
        strokeLinejoin={strokeLinejoin}
        {...props}
      />
    );
  });

  WrappedIcon.displayName = `UiIcon(${Icon.displayName ?? Icon.name ?? "Symbol"})`;

  return WrappedIcon as SymbolIconComponent;
}

export const ArrowDownLeft = withIconDefaults(IconArrowDownLeft);
export const ArrowLeft = withIconDefaults(IconArrowLeft);
export const ArrowUpRight = withIconDefaults(IconArrowUpRight);
export const BadgeDollarSign = withIconDefaults(IconDollarsign);
export const BookOpen = withIconDefaults(IconBookPages);
export const Check = withIconDefaults(IconCheckmark);
export const CheckCircle2 = withIconDefaults(IconCheckmarkCircle);
export const CheckIcon = withIconDefaults(IconCheckmark);
export const ChevronDown = withIconDefaults(IconChevronDown);
export const ChevronDownIcon = withIconDefaults(IconChevronDown);
export const ChevronRight = withIconDefaults(IconChevronRight);
export const ChevronRightIcon = withIconDefaults(IconChevronRight);
export const ChevronUpIcon = withIconDefaults(IconChevronUp);
export const CircleHelp = withIconDefaults(IconQuestionmarkCircle);
export const CircleIcon = withIconDefaults(IconCircleFill);
export const Clock3 = withIconDefaults(IconClock);
export const Coins = withIconDefaults(IconDollarsignCircle);
export const Copy = withIconDefaults(IconDocumentOnDocument);
export const Droplets = withIconDefaults(IconDrop);
export const Ellipsis = withIconDefaults(IconEllipsis);
export const ExternalLink = withIconDefaults(IconArrowUpRight);
export const Gamepad2 = withIconDefaults(IconGamecontroller);
export const Home = withIconDefaults(IconHouse);
export const KeyRound = withIconDefaults(IconKey);
export const Loader2 = withIconDefaults(IconArrowTrianglehead2ClockwiseRotate90);
export const PanelLeft = withIconDefaults(IconSidebarLeft);
export const PanelRight = withIconDefaults(IconSidebarRight);
export const Pencil = withIconDefaults(IconPencil);
export const Play = withIconDefaults(IconPlay);
export const Plus = withIconDefaults(IconPlus);
export const RefreshCw = withIconDefaults(IconArrowClockwise);
export const Search = withIconDefaults(IconMagnifyingglass);
export const Send = withIconDefaults(IconPaperplane);
export const Settings2 = withIconDefaults(IconGearshape2);
export const ShieldAlert = withIconDefaults(IconShieldLefthalfFilledTrianglebadgeExclamationmark);
export const ShieldCheck = withIconDefaults(IconShieldLefthalfFilledBadgeCheckmark);
export const Sparkles = withIconDefaults(IconSparkles);
export const Wallet = withIconDefaults(IconWalletPass);
export const X = withIconDefaults(IconXmark);

export const NavHome = withIconDefaults(IconHouse);
export const NavWallets = withIconDefaults(IconWalletBifold);
export const NavIssuance = withIconDefaults(IconSquareStack3dUp);
export const NavPayments = withIconDefaults(IconArrowLeftAndRightCircle);
export const NavApiKeys = withIconDefaults(IconKeyHorizontal);
export const NavDocs = withIconDefaults(IconBookClosed);
export const NavSettings = withIconDefaults(IconGearshape2);

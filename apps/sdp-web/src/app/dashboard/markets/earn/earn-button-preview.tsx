"use client";

import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export const EARN_BUTTON_STYLES = ["ink", "light", "accent"] as const;
export type EarnButtonStyle = (typeof EARN_BUTTON_STYLES)[number];

export const EARN_BUTTON_STYLE_CLASS_NAMES = {
  ink: "bg-primary text-on-primary shadow-sm",
  light: "border border-border-default bg-surface-raised text-primary shadow-sm",
  accent: "bg-[#14F195] text-[#0f0f10] shadow-sm",
} as const satisfies Record<EarnButtonStyle, string>;

export function EarnDepositButtonPreview({
  className,
  compact = false,
  style,
}: {
  className?: string;
  compact?: boolean;
  style: EarnButtonStyle;
}) {
  const t = useTranslations();
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-lg font-medium",
        compact ? "h-8 px-3 text-xs" : "h-11 px-5 text-sm",
        EARN_BUTTON_STYLE_CLASS_NAMES[style],
        className
      )}
    >
      {t("DashboardMarkets.earnProgram.buttonLabel")}
    </span>
  );
}

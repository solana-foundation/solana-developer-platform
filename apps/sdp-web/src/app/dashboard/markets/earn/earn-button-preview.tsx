"use client";

import { DEFAULT_EARN_BUTTON_ACCENT_COLOR, type EarnButtonStyle } from "@sdp/types";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export const EARN_BUTTON_STYLE_CLASS_NAMES = {
  ink: "bg-primary text-on-primary shadow-sm",
  light: "border border-border-default bg-surface-raised text-primary shadow-sm",
  accent: "shadow-sm",
} as const satisfies Record<EarnButtonStyle, string>;

function accentForeground(accentColor: string): string {
  const red = Number.parseInt(accentColor.slice(1, 3), 16);
  const green = Number.parseInt(accentColor.slice(3, 5), 16);
  const blue = Number.parseInt(accentColor.slice(5, 7), 16);
  const perceivedBrightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return perceivedBrightness > 150 ? "#0f0f10" : "#ffffff";
}

export function EarnDepositButtonPreview({
  accentColor = DEFAULT_EARN_BUTTON_ACCENT_COLOR,
  className,
  compact = false,
  style,
}: {
  accentColor?: string;
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
      style={
        style === "accent"
          ? { backgroundColor: accentColor, color: accentForeground(accentColor) }
          : undefined
      }
    >
      {t("DashboardMarkets.earnProgram.buttonLabel")}
    </span>
  );
}

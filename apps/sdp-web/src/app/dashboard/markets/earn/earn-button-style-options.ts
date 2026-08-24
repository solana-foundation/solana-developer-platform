import { DEFAULT_EARN_BUTTON_ACCENT_COLOR, type EarnButtonStyle } from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";

export const EARN_BUTTON_STYLE_OPTIONS = [
  {
    value: "ink",
    labelKey: "DashboardMarkets.earnProgram.styleInk",
  },
  {
    value: "light",
    labelKey: "DashboardMarkets.earnProgram.styleLight",
  },
  {
    value: "accent",
    labelKey: "DashboardMarkets.earnProgram.styleAccent",
  },
] as const satisfies ReadonlyArray<{
  value: EarnButtonStyle;
  labelKey: MessageKey;
}>;

export const EARN_BUTTON_ACCENT_COLOR_OPTIONS = [
  {
    color: DEFAULT_EARN_BUTTON_ACCENT_COLOR,
    labelKey: "DashboardMarkets.earnProgram.accentSolana",
  },
  { color: "#9945FF", labelKey: "DashboardMarkets.earnProgram.accentPurple" },
  { color: "#4C6FFF", labelKey: "DashboardMarkets.earnProgram.accentBlue" },
  { color: "#FF6B6B", labelKey: "DashboardMarkets.earnProgram.accentCoral" },
  { color: "#F5B942", labelKey: "DashboardMarkets.earnProgram.accentGold" },
] as const satisfies ReadonlyArray<{ color: string; labelKey: MessageKey }>;

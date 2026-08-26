import {
  DEFAULT_EARN_BUTTON_ACCENT_COLOR,
  EARN_BUTTON_STYLES,
  type EarnButtonStyle,
} from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";

// Keyed by the shared style union so a style added in @sdp/types without a
// label here fails to COMPILE — no runtime assertion needed.
const EARN_BUTTON_STYLE_LABEL_KEYS = {
  ink: "DashboardMarkets.earnProgram.styleInk",
  light: "DashboardMarkets.earnProgram.styleLight",
  accent: "DashboardMarkets.earnProgram.styleAccent",
} as const satisfies Record<EarnButtonStyle, MessageKey>;

export const EARN_BUTTON_STYLE_OPTIONS = EARN_BUTTON_STYLES.map((value) => ({
  value,
  labelKey: EARN_BUTTON_STYLE_LABEL_KEYS[value],
}));

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

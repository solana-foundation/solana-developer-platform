import { tailwindThemeScales } from "@sdp/design-tokens";
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The design tokens' own scale names (text-body, rounded-control, h-control-md, max-w-flow), so
// merging keeps a token size beside a colour instead of treating both as `text-*` colours.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [...tailwindThemeScales.text],
      radius: [...tailwindThemeScales.radius],
      spacing: [...tailwindThemeScales.spacing],
      container: [...tailwindThemeScales.container],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const DISPLAY_LABEL_OVERRIDES: Record<string, string> = {
  rwa: "RWA",
};

export function formatDisplayLabel(value: string): string {
  const lower = value.toLowerCase();
  if (DISPLAY_LABEL_OVERRIDES[lower]) return DISPLAY_LABEL_OVERRIDES[lower];

  // tokenized-security => Tokenized Security, force_burn => Force Burn, rwa => RWA
  return value.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

import { tailwindThemeScales } from "@sdp/design-tokens";
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The design tokens' own scale names (text-body, rounded-control, h-control-md, max-w-flow,
// shadow-chip), so merging keeps a token size beside a colour instead of treating both as colours.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [...tailwindThemeScales.text],
      radius: [...tailwindThemeScales.radius],
      spacing: [...tailwindThemeScales.spacing],
      container: [...tailwindThemeScales.container],
      shadow: [...tailwindThemeScales.shadow],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

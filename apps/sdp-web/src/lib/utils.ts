import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

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

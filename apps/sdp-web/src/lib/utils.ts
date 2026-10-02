// One class merger for the app and its @sdp/ui primitives (token-aware tailwind-merge).
export { cn } from "@sdp/ui/cn";

const DISPLAY_LABEL_OVERRIDES: Record<string, string> = {
  rwa: "RWA",
};

export function formatDisplayLabel(value: string): string {
  const lower = value.toLowerCase();
  if (DISPLAY_LABEL_OVERRIDES[lower]) return DISPLAY_LABEL_OVERRIDES[lower];

  // tokenized-security => Tokenized Security, force_burn => Force Burn, rwa => RWA
  return value.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

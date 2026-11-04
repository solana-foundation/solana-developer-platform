import type { MessageKey } from "@/i18n/messages";

export const ACCOUNT_TABS = [
  { id: "profile", labelKey: "Shared.account.tabs.profile" },
  { id: "security", labelKey: "Shared.account.tabs.security" },
  { id: "preferences", labelKey: "Shared.account.tabs.preferences" },
] as const satisfies readonly { id: string; labelKey: MessageKey }[];

import type { MessageKey } from "@/i18n/messages";
import type { DashboardCapabilities } from "@/lib/dashboard-access";

export const SETTINGS_TABS = [
  { id: "general", labelKey: "Shared.organizationSettings.tabs.general" },
  {
    id: "members",
    labelKey: "Shared.organizationSettings.tabs.members",
    capability: "canManageOrgSettings",
  },
  {
    id: "security",
    labelKey: "Shared.organizationSettings.tabs.security",
    capability: "canManageOrgSettings",
  },
] as const satisfies readonly {
  id: string;
  labelKey: MessageKey;
  capability?: keyof DashboardCapabilities;
}[];

"use client";

import { listActionsForAsset } from "@sdp/issuance/workflows";
import type { AssetCategory, SelectedSetting } from "@sdp/types";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import type { AccessControlMode, AdvancedSettingsDraft } from "./issuance-draft-wizard.types";

const TIER_VARIANT: Record<
  "automated" | "sensitive" | "requires_approval",
  "success" | "warning" | "danger"
> = {
  automated: "success",
  sensitive: "warning",
  requires_approval: "danger",
};

// "kyc_approved" → "KYC approved". Fallback when a catalog key lacks a translation.
function humanize(type: string): string {
  const spaced = type.replace(/_/g, " ");
  return (spaced.charAt(0).toUpperCase() + spaced.slice(1)).replace(/\bkyc\b/gi, "KYC");
}

// Read-only "automations you'll unlock" preview, computed entirely client-side from the
// current draft selections via the pure workflow catalog. Purely informational — deploy
// is irreversible, so it shows what the chosen extensions/allowlist will enable in the
// Workflows tab once the asset is live. No token exists yet at this step.
export function WorkflowPreview({
  category,
  type,
  settings,
  accessControl,
}: {
  category: AssetCategory | null;
  type: string | null;
  settings: AdvancedSettingsDraft;
  accessControl: AccessControlMode | "";
}) {
  const t = useTranslations();
  const wf = (k: string) => t(`DashboardIssuance.workflows.${k}` as Parameters<typeof t>[0]);
  const actionLabel = (actionType: string): string => {
    try {
      return t(`DashboardIssuance.workflows.actionLabels.${actionType}` as Parameters<typeof t>[0]);
    } catch {
      return humanize(actionType);
    }
  };

  if (!category || !type) {
    return null;
  }

  const available = listActionsForAsset({
    category,
    type,
    selectedSettings: settings as Record<string, SelectedSetting>,
    hasAllowlist: accessControl === "allowlist",
  });
  const unlocked = available.filter((entry) => entry.support.ok);

  return (
    <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
      <h3 className="text-sm font-semibold text-primary">{wf("previewTitle")}</h3>
      <p className="mt-1 text-sm text-secondary">{wf("previewIntro")}</p>

      {unlocked.length === 0 ? (
        <p className="mt-4 text-sm text-secondary">{wf("previewEmpty")}</p>
      ) : (
        <ul className="mt-4 flex flex-wrap gap-2">
          {unlocked.map((entry) => (
            <li
              key={entry.type}
              className="inline-flex items-center gap-2 rounded-full border border-border-default bg-fill-subtle px-3 py-1.5 text-sm"
            >
              <span className="font-medium text-primary">{actionLabel(entry.type)}</span>
              <Badge variant={TIER_VARIANT[entry.action.execution]}>
                {wf(`tierLabels.${entry.action.execution}`)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

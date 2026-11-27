"use client";

import { API_KEY_REQUESTS_PER_MINUTE } from "@sdp/types/api-keys";
import { MAX_ORGANIZATION_MEMBERS } from "@sdp/types/organizations";
import {
  RecordList,
  RecordRow,
  RecordSection,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { useDeploymentSandboxOnly } from "@/lib/deployment-sandbox-only";

/**
 * The organization's plan. Every organization starts on Free: devnet, API keys at the standard
 * per-key limit and the full member seats, with no review. Mainnet joins once its access is
 * approved, which is when the API starts listing the production project. A devnet-only
 * deployment takes no mainnet request, so its plan names devnet alone.
 */
export function PlanSection() {
  const t = useTranslations();
  const { sandboxProject, productionProject } = useDashboardWorkspace();
  const sandboxOnly = useDeploymentSandboxOnly(sandboxProject?.organizationId ?? null);
  return (
    <RecordSection title={t("Shared.organizationSettings.planTitle")}>
      <RecordList>
        <RecordRow label={t("Shared.organizationSettings.plan")}>
          {t("Shared.organizationSettings.planFree")}
        </RecordRow>
        <RecordRow label={t("Shared.organizationSettings.planNetworks")}>
          {t(networksKey(sandboxOnly, productionProject !== null))}
        </RecordRow>
        <RecordRow label={t("Shared.organizationSettings.planApiKeys")}>
          {t("Shared.organizationSettings.planApiKeysLimit", {
            count: API_KEY_REQUESTS_PER_MINUTE.standard,
          })}
        </RecordRow>
        <RecordRow label={t("Shared.organizationSettings.planMembers")}>
          {t("Shared.organizationSettings.planMembersLimit", { count: MAX_ORGANIZATION_MEMBERS })}
        </RecordRow>
      </RecordList>
    </RecordSection>
  );
}

/** What the plan's networks row says: devnet alone, devnet with mainnet pending, or both. */
function networksKey(sandboxOnly: boolean, mainnetApproved: boolean): MessageKey {
  if (sandboxOnly) return "Shared.organizationSettings.planNetworksDevnetOnly";
  return mainnetApproved
    ? "Shared.organizationSettings.planNetworksBoth"
    : "Shared.organizationSettings.planNetworksDevnet";
}

import { type AllowedOperation, OPERATION_FAMILIES, type OperationFamily } from "@sdp/types";
import type { useTranslations } from "@/i18n/provider";
import { summarizeAllowedOperations } from "./api-key-authoring";

type Translate = ReturnType<typeof useTranslations>;

export const API_KEY_OPERATION_FAMILIES: readonly OperationFamily[] = OPERATION_FAMILIES;

export function familyLabel(family: OperationFamily, t: Translate): string {
  const labels: Record<OperationFamily, string> = {
    payment: t("DashboardCustody.apiKeyFamilyPayment"),
    ramp: t("DashboardCustody.apiKeyFamilyRamp"),
    issuance: t("DashboardCustody.apiKeyFamilyIssuance"),
    program: t("DashboardCustody.apiKeyFamilyProgram"),
    privacy: t("DashboardCustody.apiKeyFamilyPrivacy"),
  };
  return labels[family];
}

export function familyDescription(family: OperationFamily, t: Translate): string {
  const descriptions: Record<OperationFamily, string> = {
    payment: t("DashboardCustody.apiKeyFamilyPaymentDescription"),
    ramp: t("DashboardCustody.apiKeyFamilyRampDescription"),
    issuance: t("DashboardCustody.apiKeyFamilyIssuanceDescription"),
    program: t("DashboardCustody.apiKeyFamilyProgramDescription"),
    privacy: t("DashboardCustody.apiKeyFamilyPrivacyDescription"),
  };
  return descriptions[family];
}

/** One line naming what a key may do: everything, or the ticked families and actions. */
export function operationsSummaryLabel(
  allowedOperations: readonly AllowedOperation[],
  t: Translate
): string {
  const summary = summarizeAllowedOperations(allowedOperations);
  if (summary.kind === "unrestricted") {
    return t("DashboardCustody.apiKeyOperationsAll");
  }
  const parts: string[] = summary.families.map((family) => familyLabel(family, t));
  if (summary.typeCount > 0) {
    parts.push(t("DashboardCustody.apiKeyOperationsSpecificCount", { count: summary.typeCount }));
  }
  return parts.join(", ");
}

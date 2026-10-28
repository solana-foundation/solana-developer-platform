import type { MessageKey } from "@/i18n/messages";
import type { useTranslations } from "@/i18n/provider";
import type { EarnVaultQueuedWithdrawalOutcome } from "./earn-program-data";

/**
 * The step rail of the shared vault-withdrawal-request flow (see
 * `earn-vault-withdrawal-request-flow.tsx` for the hooks and components that
 * render it): details → review, then the placed request record. Pure logic,
 * kept out of the component file so it stays Fast-Refresh clean.
 */

export type WithdrawalRequestFlowStep = "details" | "review";

/** The three named steps: details, review, then the request record. */
export function withdrawalRequestFlowSteps(
  t: ReturnType<typeof useTranslations>,
  requestedStepKey: MessageKey
): string[] {
  return [
    t("DashboardEarn.vaultWithdraw.flowDetails"),
    t("DashboardEarn.vaultWithdraw.flowReview"),
    t(requestedStepKey),
  ];
}

export function withdrawalRequestFlowStepIndex(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: WithdrawalRequestFlowStep
): number {
  if (outcome) return 2;
  return step === "review" ? 1 : 0;
}

export function withdrawalRequestFlowStepKey(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: WithdrawalRequestFlowStep
): string {
  return outcome ? `result:${outcome.kind}` : step;
}

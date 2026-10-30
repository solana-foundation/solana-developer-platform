import type { MessageKey } from "@/i18n/messages";
import type { useTranslations } from "@/i18n/provider";
import type { EarnVaultQueuedWithdrawalOutcome } from "./earn-program-data";

/**
 * Stepper presentation for the withdrawal-request dialogs' shared
 * details → review → outcome flow (see `earn-vault-request-flow.tsx` for the
 * lifecycle the steps wrap).
 */

/** A request dialog's form half, before the request exists. */
export type RequestFlowStep = "details" | "review";

/** The three stepper labels of a withdrawal-request flow; only the last names its outcome. */
export function withdrawalRequestFlowSteps(
  t: ReturnType<typeof useTranslations>,
  requestedKey: MessageKey
): string[] {
  return [
    t("DashboardEarn.vaultWithdraw.flowDetails"),
    t("DashboardEarn.vaultWithdraw.flowReview"),
    t(requestedKey),
  ];
}

/** The stepper position for a request flow: the outcome jumps to the result step. */
export function withdrawalRequestFlowStepIndex(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: RequestFlowStep
): number {
  if (outcome) return 2;
  return step === "review" ? 1 : 0;
}

/** The transition key for a request flow: one panel per step, then one per outcome kind. */
export function withdrawalRequestFlowStepKey(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: RequestFlowStep
): string {
  return outcome ? `result:${outcome.kind}` : step;
}

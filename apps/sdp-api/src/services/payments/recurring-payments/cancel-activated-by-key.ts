import { isCollectableRecurringPaymentStatus } from "@sdp/types/payments";
import { getDb } from "@/db/client";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import { getLogger } from "@/runtime/logger";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import type { Env } from "@/types/env";
import { cancelRecurringPayment } from "./lifecycle";

export interface CancelActivatedByKeyResult {
  canceled: string[];
  failed: string[];
}

/**
 * The compromised-key path (APE-343): cancel every active recurring payment a
 * key activated or last resumed, under its own id or one it was rotated from.
 * Revoking a key never does this on its own, because a mandate outlives the
 * key that set it up; a person asks for it on revoke, and each cancel signs as
 * that person. Each runs on its own: one that fails is reported and leaves the
 * others canceled. One with an activation, update or resume in flight cannot
 * be canceled until it settles, so it is reported as failed rather than left
 * to become active unseen.
 */
export async function cancelRecurringPaymentsActivatedByKey(
  env: Env,
  scope: { organizationId: string; projectId: string; apiKeyId: string }
): Promise<CancelActivatedByKeyResult> {
  const rows = await createPostgresPaymentRecurringPaymentsRepository(
    getDb(env)
  ).listLiveRecurringPaymentsActivatedByApiKey(scope);
  const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());
  const result: CancelActivatedByKeyResult = { canceled: [], failed: [] };
  for (const recurringPayment of rows) {
    if (!isCollectableRecurringPaymentStatus(recurringPayment.status)) {
      getLogger().warn(
        {
          event: "sdp_recurring_cancel_on_revoke_in_flight",
          organization_id: scope.organizationId,
          project_id: scope.projectId,
          api_key_id: scope.apiKeyId,
          recurring_payment_id: recurringPayment.id,
          status: recurringPayment.status,
        },
        "A recurring payment the revoked key activated has an operation in flight; cancel it once it settles"
      );
      result.failed.push(recurringPayment.id);
      continue;
    }
    try {
      const sourceWallet =
        recurringPayment.source_custody_wallet_id === null
          ? null
          : await targets.findOperationalWalletById({
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              custodyWalletId: recurringPayment.source_custody_wallet_id,
            });
      if (!sourceWallet) {
        throw new Error("Recurring payment source wallet is not operational");
      }
      await cancelRecurringPayment({
        env,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        sourceWallet,
        recurringPayment,
        // Revocation cancels under no request key, as the cron does. It signs as
        // the person revoking (requireHumanActor), whom wallet scope never narrows.
        idempotencyKey: null,
      });
      result.canceled.push(recurringPayment.id);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      getLogger().error(
        {
          event: "sdp_recurring_cancel_on_revoke_failed",
          organization_id: scope.organizationId,
          project_id: scope.projectId,
          api_key_id: scope.apiKeyId,
          recurring_payment_id: recurringPayment.id,
          error: error.message,
        },
        "A recurring payment the revoked key activated could not be canceled"
      );
      result.failed.push(recurringPayment.id);
    }
  }
  return result;
}

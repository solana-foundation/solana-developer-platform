import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import { recurringPaymentPolicyPayloadSchema, type WalletOperationActor } from "@sdp/types";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  createPaymentRecurringPaymentsRepository,
  createPolicyRepository,
  type PaymentRecurringPaymentRow,
} from "@/db/repositories";
import { internalError } from "@/lib/errors";
import {
  buildRecurringPaymentFingerprint,
  resolveIdentityBoundIdempotencyReplay,
} from "@/lib/idempotency";
import { createTenantScope, type TenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { resolveSolanaCounterpartyAccount } from "../counterparty-account-resolution";
import { enforceRecurringPaymentPolicy } from "./policy";
import { assertRecurringPaymentTokenMint } from "./shared";

export async function createRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  counterpartyId: string;
  counterpartyAccountId: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt: string | null;
  metadataUri: string | null;
  createdBy: string | null;
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
  idempotencyKey: string | null;
}): Promise<{ recurringPayment: PaymentRecurringPaymentRow; replayed: boolean }> {
  const scope = createTenantScope({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  const repository = createPaymentRecurringPaymentsRepository(input.env, scope);

  // The fingerprint covers the request AS SENT — the raw economic fields the
  // caller owns — so a retry is recognized before any resolution or policy
  // work happens, and a replay never re-evaluates policy against state that
  // may have moved on since the original attempt.
  const idempotencyFingerprint = input.idempotencyKey
    ? buildRecurringPaymentFingerprint({
        custodyWalletId: input.sourceWallet.id,
        counterpartyId: input.counterpartyId,
        counterpartyAccountId: input.counterpartyAccountId,
        token: input.token,
        amount: input.amount,
        periodHours: input.periodHours,
        firstCollectionAt: input.firstCollectionAt,
        metadataUri: input.metadataUri,
      })
    : null;

  const resolveReplay = () =>
    resolveIdentityBoundIdempotencyReplay(
      () =>
        repository.findRecurringPaymentByIdempotency({
          organizationId: input.organizationId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey as string,
        }),
      idempotencyFingerprint as string,
      (row) => row.source_custody_wallet_id === input.sourceWallet.id
    );

  if (input.idempotencyKey && idempotencyFingerprint) {
    const existing = await resolveReplay();
    if (existing) {
      return { recurringPayment: existing, replayed: true };
    }
  }

  const [tokenMint, destination] = await Promise.all([
    assertRecurringPaymentTokenMint(input.token, input.organizationId, input.projectId, input.env),
    resolveSolanaCounterpartyAccount({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      counterpartyId: input.counterpartyId,
      counterpartyAccountId: input.counterpartyAccountId,
    }),
  ]);

  const enforcement = await enforceRecurringPaymentPolicy({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    token: tokenMint,
    amount: input.amount,
    destination: destination.destinationAddress,
    apiKeyId: input.apiKeyId,
    actor: input.actor,
    rawPayload: recurringPaymentPolicyPayloadSchema.parse({
      operationType: "recurring_payment_create",
      counterpartyId: input.counterpartyId,
      counterpartyAccountId: input.counterpartyAccountId,
      periodHours: input.periodHours,
    }),
  });

  const now = new Date().toISOString();
  try {
    const recurringPayment = await repository.createRecurringPayment({
      id: `prp_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceCustodyWalletId: input.sourceWallet.id,
      sourceWalletId: input.sourceWallet.walletId,
      sourceAddress: input.sourceWallet.publicKey,
      counterpartyId: input.counterpartyId,
      counterpartyAccountId: input.counterpartyAccountId,
      destinationAddress: destination.destinationAddress,
      token: tokenMint,
      amount: input.amount,
      periodHours: input.periodHours,
      firstCollectionAt: input.firstCollectionAt,
      metadataUri: input.metadataUri,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    });

    if (!recurringPayment) {
      throw internalError("Failed to create recurring payment");
    }

    return { recurringPayment, replayed: false };
  } catch (error) {
    // A concurrent retry that claimed the same key wins the partial unique
    // index; the loser resolves the winner's row instead of surfacing a 500.
    if (input.idempotencyKey && idempotencyFingerprint && isPostgresUniqueViolation(error)) {
      const existing = await resolveReplay();
      if (existing) {
        // The winner's row is the answer, so this request's own policy
        // records are duplicates of the winner's: retire them before
        // responding, or they stay live as a second audit trail that also
        // counts toward velocity sums.
        await cancelConcurrentRetryWalletOperation(input.env, scope, enforcement);
        return { recurringPayment: existing, replayed: true };
      }
    }
    throw error;
  }
}

/**
 * Retire the policy records a losing concurrent retry already wrote.
 *
 * Two requests racing on one idempotency key both pass the pre-create replay
 * lookup, and each records a wallet operation and policy evaluation before
 * either inserts the schedule. The unique index picks a winner; the loser
 * would otherwise leave an `evaluated` operation behind — a second audit
 * trail for one create that velocity sums also count, since they exclude
 * only `created`, `failed` and `canceled` rows. Transitioning it to
 * `canceled` keeps the history of what ran while ending its counting life.
 *
 * Best-effort: the replayed answer is already correct, so a compensation
 * failure is logged and never turns a successful response into an error.
 */
async function cancelConcurrentRetryWalletOperation(
  env: Env,
  scope: TenantScope,
  enforcement: WalletOperationPolicyEnforcement
): Promise<void> {
  try {
    await createPolicyRepository(env, scope).updateWalletOperationStatus(
      enforcement.operation.id,
      "canceled"
    );
  } catch (error) {
    getLogger().error(
      {
        error: error instanceof Error ? error.message : String(error),
        wallet_operation_id: enforcement.operation.id,
      },
      "Failed to cancel a losing concurrent retry's wallet operation"
    );
  }
}

import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  createPaymentRecurringPaymentsRepository,
  type PaymentRecurringPaymentRow,
} from "@/db/repositories";
import { internalError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { resolveSolanaCounterpartyAccount } from "../counterparty-account-resolution";
import { assertRecurringPaymentTokenMint } from "./shared";

/** A create request's Idempotency-Key and the fingerprint of the schedule it creates. */
export interface RecurringPaymentIdempotency {
  key: string;
  fingerprint: string;
}

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
  /** Recorded on the row, the schedule's recovery point (HOO-1918, migration 0134). */
  idempotency: RecurringPaymentIdempotency | null;
}): Promise<PaymentRecurringPaymentRow> {
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

  const scope = createTenantScope({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  const repository = createPaymentRecurringPaymentsRepository(input.env, scope);
  const now = new Date().toISOString();
  let recurringPayment: PaymentRecurringPaymentRow | null;
  try {
    recurringPayment = await repository.createRecurringPayment({
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
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotency?.key ?? null,
      idempotencyFingerprint: input.idempotency?.fingerprint ?? null,
    });
  } catch (error) {
    // A concurrent request with the same key won the insert: answer with its row.
    const raced =
      input.idempotency && isPostgresUniqueViolation(error)
        ? await findKeyedRecurringPayment(input.env, input, input.idempotency.key)
        : null;
    if (!raced) throw error;
    return raced.recurringPayment;
  }

  if (!recurringPayment) {
    throw internalError("Failed to create recurring payment");
  }

  return recurringPayment;
}

/**
 * The schedule a create request's record key already made, with the key
 * layer's fingerprint it recorded, or null for none. `replayFromRecord`
 * compares the fingerprint.
 */
export async function findKeyedRecurringPayment(
  env: Env,
  tenant: { organizationId: string; projectId: string },
  idempotencyKey: string
): Promise<{ recurringPayment: PaymentRecurringPaymentRow; fingerprint: string } | null> {
  const repository = createPaymentRecurringPaymentsRepository(env, createTenantScope(tenant));
  const keyed = await repository.findRecurringPaymentByIdempotencyKey({
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    idempotencyKey,
  });
  if (!keyed || keyed.idempotencyFingerprint === null) return null;
  // The route's authorize step already checked the caller's wallet access.
  const recurringPayment = await repository.getRecurringPaymentById({
    recurringPaymentId: keyed.id,
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    walletAuthorization: null,
  });
  return recurringPayment && { recurringPayment, fingerprint: keyed.idempotencyFingerprint };
}

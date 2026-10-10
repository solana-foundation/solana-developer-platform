import { recurringPaymentPolicyPayloadSchema, type WalletOperationActor } from "@sdp/types";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  createPaymentRecurringPaymentsRepository,
  type PaymentRecurringPaymentRow,
} from "@/db/repositories";
import type { PaymentRecurringWalletAuthorization } from "@/db/repositories/payment-recurring-payments.repository";
import { AppError, internalError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
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
  /** The request's Idempotency-Key and the fingerprint of what it creates. */
  idempotency: { key: string; fingerprint: string } | null;
  /** The caller's wallet access, applied when a keyed retry reads its schedule back. */
  walletAuthorization: PaymentRecurringWalletAuthorization | null;
}): Promise<PaymentRecurringPaymentRow> {
  const scope = createTenantScope({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  const repository = createPaymentRecurringPaymentsRepository(input.env, scope);
  // A retry the shared Idempotency-Key record no longer covers (past 24 hours,
  // or after a 5xx that frees the key) finds the schedule it already created,
  // before the mint, counterparty and policy reads run again (HOO-1918).
  const existing = input.idempotency && (await findKeyedRecurringPayment(repository, input));
  if (existing) {
    return existing;
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

  await enforceRecurringPaymentPolicy({
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
  const insert = () =>
    repository.createRecurringPayment({
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
  let recurringPayment: PaymentRecurringPaymentRow | null;
  try {
    recurringPayment = await insert();
  } catch (error) {
    // A concurrent request with the same key won the insert.
    const raced =
      input.idempotency && isPostgresUniqueViolation(error)
        ? await findKeyedRecurringPayment(repository, input)
        : null;
    if (!raced) throw error;
    return raced;
  }

  if (!recurringPayment) {
    throw internalError("Failed to create recurring payment");
  }

  return recurringPayment;
}

async function findKeyedRecurringPayment(
  repository: ReturnType<typeof createPaymentRecurringPaymentsRepository>,
  input: {
    organizationId: string;
    projectId: string;
    idempotency: { key: string; fingerprint: string } | null;
    walletAuthorization: PaymentRecurringWalletAuthorization | null;
  }
): Promise<PaymentRecurringPaymentRow | null> {
  if (!input.idempotency) return null;
  const keyed = await repository.findRecurringPaymentByIdempotencyKey({
    organizationId: input.organizationId,
    projectId: input.projectId,
    idempotencyKey: input.idempotency.key,
  });
  if (!keyed) return null;
  if (keyed.idempotencyFingerprint !== input.idempotency.fingerprint) {
    throw new AppError("IDEMPOTENCY_KEY_REUSED");
  }
  // The fingerprint pins the source wallet; the read still applies the
  // caller's current wallet access, so a narrowed key finds nothing.
  return repository.getRecurringPaymentById({
    recurringPaymentId: keyed.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    walletAuthorization: input.walletAuthorization,
  });
}

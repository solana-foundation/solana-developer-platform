import type { WalletOperationActor } from "@sdp/types";
import {
  createPaymentRecurringPaymentsRepository,
  type PaymentRecurringPaymentRow,
} from "@/db/repositories";
import { AppError } from "@/lib/errors";
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
  firstCollectionAt?: string | null;
  metadataUri?: string | null;
  createdBy: string | null;
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
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
  await enforceRecurringPaymentPolicy({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    operationType: "recurring_payment_create",
    token: tokenMint,
    amount: input.amount,
    destination: destination.destinationAddress,
    apiKeyId: input.apiKeyId,
    actor: input.actor,
    rawPayload: {
      counterpartyId: input.counterpartyId,
      counterpartyAccountId: input.counterpartyAccountId,
      periodHours: input.periodHours,
    },
  });

  const now = new Date().toISOString();
  const recurringPayment = await createPaymentRecurringPaymentsRepository(
    input.env,
    scope
  ).createRecurringPayment({
    id: `prp_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: input.sourceWallet.walletId,
    sourceAddress: input.sourceWallet.publicKey,
    counterpartyId: input.counterpartyId,
    counterpartyAccountId: input.counterpartyAccountId,
    destinationAddress: destination.destinationAddress,
    token: tokenMint,
    amount: input.amount,
    periodHours: input.periodHours,
    firstCollectionAt: input.firstCollectionAt ?? null,
    metadataUri: input.metadataUri ?? null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!recurringPayment) {
    throw new AppError("INTERNAL_ERROR", "Failed to create recurring payment");
  }

  return recurringPayment;
}

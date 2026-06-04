import { getDb } from "@/db";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPostgresPaymentRecurringPaymentsRepository,
  createPostgresPaymentSubscriptionsRepository,
} from "@/db/repositories";
import type {
  PaymentRecurringPaymentRow,
  UpdatePaymentRecurringPaymentInput,
} from "@/db/repositories/payment-recurring-payments.repository";
import type { PaymentSubscriptionCollectionAttemptRow } from "@/db/repositories/payment-subscriptions.repository";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { AppError } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import { createSigningService } from "@/services/domain/signing.service";
import { assertWalletPolicyAllowsTransferWithRepository } from "@/services/payments/wallet-policy";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { resolveSolanaCounterpartyAccount } from "./counterparty-account-resolution";
import {
  assertSubscriptionTokenMint,
  collectSubscriptionOnChain,
  deriveAssociatedTokenAccount,
  ensureSubscriptionAuthorizationOnChain,
  ensureSubscriptionPlanOnChain,
  executeSubscriptionLifecycleOnChain,
  generateProgramPlanId,
  resolveRecurringSubscriptionRuntime,
} from "./solana-subscriptions-adapter";

export type ActivationResult = {
  recurringPayment: PaymentRecurringPaymentRow;
  planSignature?: string;
  authorizationSignature?: string;
};

export type CollectionResult = {
  recurringPayment: PaymentRecurringPaymentRow;
  collectionAttempt: PaymentSubscriptionCollectionAttemptRow;
  transfer: PaymentTransferRow;
};

function addPeriodHours(timestamp: string, periodHours: number): string {
  return new Date(new Date(timestamp).getTime() + periodHours * 60 * 60 * 1000).toISOString();
}

async function getSourceSigner(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
  expectedAddress: string;
}) {
  const signer = await solanaServices.createOrgSigner(
    input.env,
    input.organizationId,
    input.projectId,
    input.sourceWalletId
  );

  if (signer.address !== input.expectedAddress) {
    throw new AppError("BAD_REQUEST", "Resolved signing wallet does not match source wallet");
  }

  return signer;
}

async function resolveSourceWalletForExecution(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWalletId: string;
}): Promise<CustodyWallet> {
  const signingService = createSigningService(input.env);
  const wallets = await signingService.getWalletsWithProviders(
    input.organizationId,
    input.projectId,
    { includeAllProviders: true }
  );
  const wallet = wallets.find((entry) => entry.walletId === input.sourceWalletId);

  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found. Provision wallets through /v1/wallets");
  }

  return wallet;
}

async function createTransferRecord(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPayment: PaymentRecurringPaymentRow;
  status: PaymentTransferStatus;
  initiatedByKeyId?: string | null;
}) {
  const now = new Date().toISOString();
  const transfer = await createPaymentsRepository(input.env).createTransfer({
    id: `xfr_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    walletId: input.recurringPayment.source_wallet_id,
    sourceAddress: input.recurringPayment.source_address,
    destinationAddress: input.recurringPayment.destination_address,
    token: input.recurringPayment.token,
    amount: input.recurringPayment.amount,
    memo: null,
    type: "transfer",
    direction: "outbound",
    status: input.status,
    serializedTx: null,
    initiatedByKeyId: input.initiatedByKeyId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (!transfer) {
    throw new AppError("INTERNAL_ERROR", "Failed to create payment transfer record");
  }

  return transfer;
}

async function updateTransferRecord(input: {
  env: Env;
  transferId: string;
  status?: PaymentTransferStatus;
  signature?: string | null;
  slot?: number | null;
  blockTime?: string | null;
  error?: string | null;
}) {
  const updated = await createPaymentsRepository(input.env).updateTransfer({
    transferId: input.transferId,
    status: input.status,
    signature: input.signature,
    slot: input.slot,
    blockTime: input.blockTime,
    error: input.error,
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    throw new AppError("INTERNAL_ERROR", "Payment transfer record not found for update");
  }

  return updated;
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
  firstCollectionAt?: string | null;
  metadataUri?: string | null;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  assertSubscriptionTokenMint(input.token);

  const destination = await resolveSolanaCounterpartyAccount({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    counterpartyId: input.counterpartyId,
    counterpartyAccountId: input.counterpartyAccountId,
  });
  await assertWalletPolicyAllowsTransferWithRepository(createPaymentsRepository(input.env), {
    organizationId: input.organizationId,
    projectId: input.projectId,
    wallet: input.sourceWallet,
    destinationAddress: destination.destinationAddress,
    token: input.token,
    amount: input.amount,
  });

  const now = new Date().toISOString();
  const recurringPayment = await createPaymentRecurringPaymentsRepository(
    input.env
  ).createRecurringPayment({
    id: `prp_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: input.sourceWallet.walletId,
    sourceAddress: input.sourceWallet.publicKey,
    counterpartyId: input.counterpartyId,
    counterpartyAccountId: input.counterpartyAccountId,
    destinationAddress: destination.destinationAddress,
    token: input.token,
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

export async function activateRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
}): Promise<ActivationResult> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  let recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  if (recurringPayment.status === "active") {
    return { recurringPayment };
  }
  if (recurringPayment.status !== "pending_activation") {
    throw new AppError(
      "BAD_REQUEST",
      "Recurring payment cannot be activated from its current status"
    );
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const sourceSigner = await getSourceSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: recurringPayment.source_wallet_id,
    expectedAddress: sourceAddress,
  });
  const runtime = await resolveRecurringSubscriptionRuntime(input.env, recurringPayment);
  const destinationAddress = assertValidAddress(
    recurringPayment.destination_address,
    "destinationAddress"
  );
  const destinationTokenAccount = await deriveAssociatedTokenAccount({
    owner: destinationAddress,
    runtime,
  });
  const now = new Date().toISOString();
  const createdBy = recurringPayment.created_by;
  const planRecord = recurringPayment.plan_id
    ? await subscriptionsRepo.getPlanById({
        planId: recurringPayment.plan_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      })
    : null;
  const programPlanId = planRecord?.program_plan_id ?? generateProgramPlanId();
  const plan =
    planRecord ??
    (await subscriptionsRepo.createPlan({
      id: `psp_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      ownerWalletId: recurringPayment.source_wallet_id,
      ownerAddress: recurringPayment.source_address,
      token: recurringPayment.token,
      amount: recurringPayment.amount,
      periodHours: recurringPayment.period_hours,
      programPlanId,
      planPda: null,
      destinationAddress: destinationTokenAccount,
      pullerWalletId: recurringPayment.source_wallet_id,
      pullerAddress: recurringPayment.source_address,
      metadataUri: recurringPayment.metadata_uri,
      status: "draft",
      createdBy,
      createdAt: now,
      updatedAt: now,
    }));

  if (!plan) {
    throw new AppError("INTERNAL_ERROR", "Failed to create subscription plan");
  }

  const onChainPlan = await ensureSubscriptionPlanOnChain({
    env: input.env,
    sourceSigner,
    sourceAddress,
    destinationTokenAccount,
    programPlanId,
    metadataUri: recurringPayment.metadata_uri ?? "",
    runtime,
    periodHours: recurringPayment.period_hours,
    existingSignature: recurringPayment.plan_creation_signature,
  });
  const subscriptionRecord = recurringPayment.subscription_id
    ? await subscriptionsRepo.getSubscriptionById({
        subscriptionId: recurringPayment.subscription_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      })
    : null;
  const subscription =
    subscriptionRecord ??
    (await subscriptionsRepo.createSubscription({
      id: `psub_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planId: plan.id,
      counterpartyId: recurringPayment.counterparty_id,
      subscriberAddress: recurringPayment.source_address,
      subscriberTokenAccount: runtime.sourceTokenAccount,
      subscriptionPda: null,
      subscriptionAuthorityAddress: null,
      authorizationSignature: null,
      status: "pending_authorization",
      currentPeriodStartAt: null,
      nextCollectionDueAt: null,
      createdBy,
      createdAt: now,
      updatedAt: now,
    }));

  if (!subscription) {
    throw new AppError("INTERNAL_ERROR", "Failed to create subscription");
  }

  const onChainAuthorization = await ensureSubscriptionAuthorizationOnChain({
    env: input.env,
    sourceSigner,
    sourceAddress,
    sourceTokenAccount: runtime.sourceTokenAccount,
    planId: onChainPlan.planId,
    planPda: onChainPlan.planPda,
    planCreatedAt: onChainPlan.planCreatedAt,
    runtime,
    periodHours: recurringPayment.period_hours,
    existingSignature:
      recurringPayment.authorization_signature ?? subscriptionRecord?.authorization_signature,
  });
  const dueAt = recurringPayment.first_collection_at ?? new Date().toISOString();
  const updatedPlan = await subscriptionsRepo.updatePlan({
    planId: plan.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    planPda: onChainPlan.planPda,
    destinationAddress: destinationTokenAccount,
    pullerWalletId: recurringPayment.source_wallet_id,
    pullerAddress: recurringPayment.source_address,
    status: "active",
    updatedAt: new Date().toISOString(),
  });
  const updatedSubscription = await subscriptionsRepo.updateSubscription({
    subscriptionId: subscription.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    subscriberTokenAccount: runtime.sourceTokenAccount,
    subscriptionPda: onChainAuthorization.subscriptionPda,
    subscriptionAuthorityAddress: onChainAuthorization.subscriptionAuthorityAddress,
    authorizationSignature: onChainAuthorization.signature ?? null,
    status: "active",
    currentPeriodStartAt: dueAt,
    nextCollectionDueAt: dueAt,
    updatedAt: new Date().toISOString(),
  });

  if (!updatedPlan || !updatedSubscription) {
    throw new AppError("INTERNAL_ERROR", "Failed to activate subscription records");
  }

  recurringPayment = await recurringRepo.updateRecurringPayment({
    recurringPaymentId: recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    destinationTokenAccount,
    nextCollectionDueAt: dueAt,
    planId: plan.id,
    subscriptionId: subscription.id,
    planPda: onChainPlan.planPda,
    planCreatedAt: onChainPlan.planCreatedAt.toString(),
    planCreationSignature: onChainPlan.signature ?? null,
    subscriptionPda: onChainAuthorization.subscriptionPda,
    subscriptionAuthorityAddress: onChainAuthorization.subscriptionAuthorityAddress,
    authorizationSignature:
      onChainAuthorization.signature ??
      recurringPayment.authorization_signature ??
      subscriptionRecord?.authorization_signature ??
      null,
    status: "active",
    updatedAt: new Date().toISOString(),
  });

  if (!recurringPayment) {
    throw new AppError("INTERNAL_ERROR", "Failed to update recurring payment");
  }

  return {
    recurringPayment,
    planSignature: onChainPlan.signature,
    authorizationSignature: onChainAuthorization.signature,
  };
}

export async function collectRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  initiatedByKeyId?: string | null;
  enforceDue?: boolean;
  sourceWallet?: CustodyWallet;
}): Promise<CollectionResult> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  if (recurringPayment.status !== "active") {
    throw new AppError("BAD_REQUEST", "Recurring payment must be active before collection");
  }
  if (
    !recurringPayment.subscription_id ||
    !recurringPayment.plan_pda ||
    !recurringPayment.subscription_pda
  ) {
    throw new AppError("BAD_REQUEST", "Recurring payment has not been activated");
  }
  if (!recurringPayment.next_collection_due_at) {
    throw new AppError("BAD_REQUEST", "Recurring payment has no due collection");
  }

  const dueAt = recurringPayment.next_collection_due_at;
  if (input.enforceDue !== false && new Date(dueAt).getTime() > Date.now()) {
    throw new AppError("BAD_REQUEST", "Recurring payment is not due for collection");
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const destinationAddress = assertValidAddress(
    recurringPayment.destination_address,
    "destinationAddress"
  );
  const sourceWallet =
    input.sourceWallet ??
    (await resolveSourceWalletForExecution({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWalletId: recurringPayment.source_wallet_id,
    }));
  await assertWalletPolicyAllowsTransferWithRepository(createPaymentsRepository(input.env), {
    organizationId: input.organizationId,
    projectId: input.projectId,
    wallet: sourceWallet,
    destinationAddress,
    token: recurringPayment.token,
    amount: recurringPayment.amount,
  });
  const planPda = assertValidAddress(recurringPayment.plan_pda, "planPda");
  const subscriptionPda = assertValidAddress(recurringPayment.subscription_pda, "subscriptionPda");
  const sourceSigner = await getSourceSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: recurringPayment.source_wallet_id,
    expectedAddress: sourceAddress,
  });
  const runtime = await resolveRecurringSubscriptionRuntime(input.env, recurringPayment);
  let attempt = await subscriptionsRepo.getCollectionAttemptByRecurringDue({
    recurringPaymentId: recurringPayment.id,
    dueAt,
  });

  if (attempt && ["pending", "processing", "confirmed"].includes(attempt.status)) {
    throw new AppError("CONFLICT", "Collection attempt already exists for this due time");
  }

  const now = new Date().toISOString();
  try {
    attempt = await subscriptionsRepo.createCollectionAttempt({
      id: `psca_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: recurringPayment.subscription_id,
      recurringPaymentId: recurringPayment.id,
      transferId: null,
      token: recurringPayment.token,
      amount: recurringPayment.amount,
      dueAt,
      attemptedAt: now,
      status: "processing",
      signature: null,
      error: null,
      metadata: { source: "recurring_payments" },
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    attempt = await subscriptionsRepo.getCollectionAttemptByRecurringDue({
      recurringPaymentId: recurringPayment.id,
      dueAt,
    });
    if (!attempt || ["pending", "processing", "confirmed"].includes(attempt.status)) {
      throw error;
    }
  }

  if (!attempt) {
    throw new AppError("INTERNAL_ERROR", "Failed to create collection attempt");
  }

  const attemptId = attempt.id;
  let transfer: PaymentTransferRow | null = null;
  try {
    transfer = await createTransferRecord({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment,
      status: "processing",
      initiatedByKeyId: input.initiatedByKeyId ?? null,
    });
    attempt = await subscriptionsRepo.updateCollectionAttempt({
      attemptId,
      transferId: transfer.id,
      status: "processing",
      attemptedAt: now,
      updatedAt: new Date().toISOString(),
    });
    if (!attempt) {
      throw new AppError("INTERNAL_ERROR", "Failed to update collection attempt");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await subscriptionsRepo.updateCollectionAttempt({
      attemptId,
      transferId: transfer?.id,
      status: "failed",
      error: message,
      attemptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (transfer) {
      await updateTransferRecord({
        env: input.env,
        transferId: transfer.id,
        status: "failed",
        error: message,
      });
    }
    throw error;
  }
  if (!transfer) {
    throw new AppError("INTERNAL_ERROR", "Failed to create payment transfer record");
  }

  try {
    const executed = await collectSubscriptionOnChain({
      env: input.env,
      sourceSigner,
      sourceAddress,
      destinationAddress,
      planPda,
      subscriptionPda,
      runtime,
    });
    const updatedTransfer = await updateTransferRecord({
      env: input.env,
      transferId: transfer.id,
      status: "confirmed",
      signature: executed.signature,
      slot: executed.slot,
      blockTime: executed.blockTime,
      error: null,
    });
    const nextDueAt = addPeriodHours(dueAt, recurringPayment.period_hours);
    const updatedAttempt = await subscriptionsRepo.updateCollectionAttempt({
      attemptId: attempt.id,
      transferId: transfer.id,
      status: "confirmed",
      signature: executed.signature,
      attemptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const update: UpdatePaymentRecurringPaymentInput = {
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      destinationTokenAccount: executed.destinationTokenAccount,
      nextCollectionDueAt: nextDueAt,
      updatedAt: new Date().toISOString(),
    };
    const updatedRecurringPayment = await recurringRepo.updateRecurringPayment(update);
    await subscriptionsRepo.updateSubscription({
      subscriptionId: recurringPayment.subscription_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      currentPeriodStartAt: dueAt,
      nextCollectionDueAt: nextDueAt,
      updatedAt: new Date().toISOString(),
    });

    if (!updatedAttempt || !updatedRecurringPayment) {
      throw new AppError("INTERNAL_ERROR", "Failed to update recurring payment collection state");
    }

    return {
      recurringPayment: updatedRecurringPayment,
      collectionAttempt: updatedAttempt,
      transfer: updatedTransfer,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateTransferRecord({
      env: input.env,
      transferId: transfer.id,
      status: "failed",
      error: message,
    });
    const failedAttempt = await subscriptionsRepo.updateCollectionAttempt({
      attemptId: attempt.id,
      transferId: transfer.id,
      status: "failed",
      error: message,
      attemptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (failedAttempt) {
      attempt = failedAttempt;
    }

    throw error;
  }
}

export async function executeRecurringPaymentLifecycle(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  operation: "cancel" | "resume";
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const recurringPayment = await recurringRepo.getRecurringPaymentById({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  if (!recurringPayment) {
    throw new AppError("NOT_FOUND", "Recurring payment not found");
  }
  const subscriptionId = recurringPayment.subscription_id;
  if (!subscriptionId || !recurringPayment.plan_pda || !recurringPayment.subscription_pda) {
    throw new AppError("BAD_REQUEST", "Recurring payment has not been activated");
  }
  if (input.operation === "cancel" && recurringPayment.status !== "active") {
    throw new AppError("BAD_REQUEST", "Only active recurring payments can be canceled");
  }
  if (
    input.operation === "resume" &&
    recurringPayment.status !== "canceled" &&
    recurringPayment.status !== "paused"
  ) {
    throw new AppError("BAD_REQUEST", "Only canceled or paused recurring payments can be resumed");
  }

  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const sourceSigner = await getSourceSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWalletId: recurringPayment.source_wallet_id,
    expectedAddress: sourceAddress,
  });
  await executeSubscriptionLifecycleOnChain({
    env: input.env,
    operation: input.operation,
    sourceSigner,
    planPda: assertValidAddress(recurringPayment.plan_pda, "planPda"),
    subscriptionPda: assertValidAddress(recurringPayment.subscription_pda, "subscriptionPda"),
  });

  const now = new Date().toISOString();
  const status = input.operation === "cancel" ? "canceled" : "active";

  return getDb(input.env).transaction(async (tx) => {
    const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
    const updated = await txRecurringRepo.updateRecurringPayment({
      recurringPaymentId: recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status,
      updatedAt: now,
    });
    const updatedSubscription = await txSubscriptionsRepo.updateSubscription({
      subscriptionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status,
      canceledAt: input.operation === "cancel" ? now : null,
      updatedAt: now,
    });

    if (!updated || !updatedSubscription) {
      throw new AppError("INTERNAL_ERROR", "Failed to update recurring payment lifecycle state");
    }

    return updated;
  });
}

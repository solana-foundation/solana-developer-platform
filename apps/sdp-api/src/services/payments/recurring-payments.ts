import {
  type Address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  type Instruction,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import * as subscriptionsProgram from "@solana/subscriptions";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
} from "@/db/repositories";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import { parseDecimalAmount } from "@/lib/amount";
import { AppError } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import {
  resolveMintDecimals,
  resolveMintTokenProgram,
  resolveSourceTokenAccount,
} from "@/routes/payments/token-accounts";
import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
import { normalizePaymentToken, SOL_MINT } from "@/services/payment-operation.service";
import { assertWalletPolicyAllowsTransferWithRepository } from "@/services/payments/wallet-policy";
import * as solanaServices from "@/services/solana";
import * as solanaRpc from "@/services/solana/rpc";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { resolveSolanaCounterpartyAccount } from "./counterparty-account-resolution";

const U64_MAX = 18_446_744_073_709_551_615n;
const ACTIVATION_STALE_MS = 5 * 60 * 1000;

function assertRecurringPaymentTokenMint(token: string): string {
  const normalized = normalizePaymentToken(token);
  if (normalized === "SOL" || normalized === SOL_MINT) {
    throw new AppError("BAD_REQUEST", "Recurring payments require an SPL token mint");
  }

  return assertValidAddress(normalized, "token");
}

function generateProgramPlanId(): string {
  const bytes = new Uint8Array(8);
  let value = 0n;

  while (value === 0n) {
    crypto.getRandomValues(bytes);
    value = 0n;
    for (const byte of bytes) {
      value = (value << 8n) | BigInt(byte);
    }
  }

  return value.toString();
}

function parseU64String(value: string, fieldName: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > U64_MAX) {
      throw new Error("out of range");
    }
    return parsed;
  } catch {
    throw new AppError("BAD_REQUEST", `${fieldName} must fit in an unsigned 64-bit integer`);
  }
}

function staleActivationCutoff(now = new Date()): string {
  return new Date(now.getTime() - ACTIVATION_STALE_MS).toISOString();
}

function isActivationAttemptStale(
  attempt: { status: string; updated_at: string } | null,
  staleBefore: string
): boolean {
  return (
    attempt?.status === "processing" && Date.parse(attempt.updated_at) < Date.parse(staleBefore)
  );
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Recurring payment activation failed";
}

async function sendSubscriptionInstructions(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  instructions: Instruction[];
}): Promise<Signature> {
  const signer = await solanaServices.createOrgSigner(
    input.env,
    input.organizationId,
    input.projectId,
    input.sourceWallet.walletId
  );

  if (signer.address !== input.sourceWallet.publicKey) {
    throw new AppError("BAD_REQUEST", "Resolved signing wallet does not match source wallet");
  }

  const rpc = solanaRpc.createRpc(input.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const feePayment = createFeePaymentAdapter(input.env);
  const feePayer = await feePayment.getFeePayer();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(input.instructions, m),
    (m) => addSignersToTransactionMessage([signer], m)
  );
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const txBytes = new Uint8Array(getTransactionEncoder().encode(partiallySigned));
  return feePayment.signAndSend(txBytes);
}

async function confirmSubscriptionSignature(env: Env, signature: Signature): Promise<void> {
  const rpc = solanaRpc.createRpc(env);
  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw new AppError("TRANSACTION_FAILED", "Recurring payment activation failed on-chain");
  }
}

async function clearRecurringPaymentFailedSignature(input: {
  recurringRepo: ReturnType<typeof createPaymentRecurringPaymentsRepository>;
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  field: "planCreationSignature" | "authorizationSignature";
}): Promise<void> {
  await input.recurringRepo.updateRecurringPaymentActivation({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ...(input.field === "planCreationSignature"
      ? { planCreationSignature: null }
      : { authorizationSignature: null }),
    updatedAt: new Date().toISOString(),
  });
}

async function confirmPersistedSubscriptionSignature(input: {
  env: Env;
  recurringRepo: ReturnType<typeof createPaymentRecurringPaymentsRepository>;
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  signature: Signature;
  field: "planCreationSignature" | "authorizationSignature";
}): Promise<void> {
  try {
    await confirmSubscriptionSignature(input.env, input.signature);
  } catch (error) {
    if (error instanceof AppError && error.code === "TRANSACTION_FAILED") {
      await clearRecurringPaymentFailedSignature(input);
    }
    throw error;
  }
}

async function fetchExistingPlanOrClearFailedSignature(input: {
  rpc: ReturnType<typeof solanaRpc.createRpc>;
  recurringRepo: ReturnType<typeof createPaymentRecurringPaymentsRepository>;
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  planPda: Address;
  planCreationSignature: string | null;
  probeWithoutSignature: boolean;
}): Promise<Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybePlan>> | null> {
  if (!input.planCreationSignature && !input.probeWithoutSignature) {
    return null;
  }

  // Deterministic PDAs let a retry recover even when the transaction landed but
  // the DB write that persisted its signature failed.
  const onChainPlan = await subscriptionsProgram.fetchMaybePlan(input.rpc, input.planPda, {
    commitment: "confirmed",
  });
  if (onChainPlan.exists) {
    return onChainPlan;
  }

  if (input.planCreationSignature) {
    await clearRecurringPaymentFailedSignature({
      recurringRepo: input.recurringRepo,
      recurringPaymentId: input.recurringPaymentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      field: "planCreationSignature",
    });
  }
  return null;
}

async function fetchExistingSubscriptionOrClearFailedSignature(input: {
  rpc: ReturnType<typeof solanaRpc.createRpc>;
  recurringRepo: ReturnType<typeof createPaymentRecurringPaymentsRepository>;
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  subscriptionPda: Address;
  authorizationSignature: string | null;
  probeWithoutSignature: boolean;
}): Promise<Awaited<
  ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>
> | null> {
  if (!input.authorizationSignature && !input.probeWithoutSignature) {
    return null;
  }

  // As with plans, the subscription PDA is the source of truth for retry
  // recovery when signature persistence did not complete.
  const onChainSubscription = await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
    input.rpc,
    input.subscriptionPda,
    { commitment: "confirmed" }
  );
  if (onChainSubscription.exists) {
    return onChainSubscription;
  }

  if (input.authorizationSignature) {
    await clearRecurringPaymentFailedSignature({
      recurringRepo: input.recurringRepo,
      recurringPaymentId: input.recurringPaymentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      field: "authorizationSignature",
    });
  }
  return null;
}

async function clearActivationSignatureIfPresent(input: {
  recurringRepo: ReturnType<typeof createPaymentRecurringPaymentsRepository>;
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  signature: string | null;
  field: "planCreationSignature" | "authorizationSignature";
}): Promise<void> {
  if (!input.signature) {
    return;
  }
  await clearRecurringPaymentFailedSignature(input);
}

async function resetRecurringPaymentActivationUnlessAlreadyActive(input: {
  recurringRepo: ReturnType<typeof createPaymentRecurringPaymentsRepository>;
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  updatedAt: string;
}): Promise<void> {
  // The repository performs this as one guarded UPDATE so a concurrent success
  // cannot be reverted from active back to pending_activation.
  await input.recurringRepo.resetRecurringPaymentActivationIfNotActive({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: input.updatedAt,
  });
}

function logActivationAttemptJournalFailures(
  results: PromiseSettledResult<unknown>[],
  context: { recurringPaymentId: string; attemptId: string }
): void {
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        "activateRecurringPayment: failed to record activation attempt journal update",
        {
          recurringPaymentId: context.recurringPaymentId,
          attemptId: context.attemptId,
          error: serializeError(result.reason),
        }
      );
    }
  }
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
  const tokenMint = assertRecurringPaymentTokenMint(input.token);
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
    enforceDailyLimit: false,
    token: tokenMint,
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

function assertActivationPreconditions(input: {
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: CustodyWallet;
}): PaymentRecurringPaymentRow | null {
  if (input.recurringPayment.status === "active") {
    return input.recurringPayment;
  }
  if (
    input.recurringPayment.status !== "pending_activation" &&
    input.recurringPayment.status !== "activating"
  ) {
    throw new AppError("BAD_REQUEST", "Recurring payment cannot be activated from this status");
  }
  if (input.recurringPayment.source_wallet_id !== input.sourceWallet.walletId) {
    throw new AppError("BAD_REQUEST", "Recurring payment source wallet does not match request");
  }
  if (input.recurringPayment.source_address !== input.sourceWallet.publicKey) {
    throw new AppError("BAD_REQUEST", "Recurring payment source address does not match wallet");
  }

  return null;
}

export async function activateRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  createdBy: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(input.env);
  const subscriptionsRepo = createPaymentSubscriptionsRepository(input.env);
  const rpc = solanaRpc.createRpc(input.env);
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = staleActivationCutoff(now);

  const idempotentActive = assertActivationPreconditions(input);
  if (idempotentActive) {
    return idempotentActive;
  }

  const claimed = await recurringRepo.claimRecurringPaymentActivation({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    staleBefore,
    updatedAt: nowIso,
  });

  if (!claimed) {
    const latest = await recurringRepo.getRecurringPaymentById({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (latest?.status === "active") {
      return latest;
    }
    throw new AppError("CONFLICT", "Recurring payment activation is already processing");
  }

  const staleAttempt = await recurringRepo.getLatestActivationAttempt({
    recurringPaymentId: claimed.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (staleAttempt && isActivationAttemptStale(staleAttempt, staleBefore)) {
    await recurringRepo.updateActivationAttempt({
      attemptId: staleAttempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "failed",
      error: "Activation attempt was reclaimed after becoming stale",
      updatedAt: nowIso,
    });
  }

  const attempt = await recurringRepo.createActivationAttempt({
    id: `prpa_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: claimed.id,
    planId: claimed.plan_id,
    subscriptionId: claimed.subscription_id,
    status: "processing",
    phase: "claim",
    planCreationSignature: claimed.plan_creation_signature,
    authorizationSignature: claimed.authorization_signature,
    error: null,
    metadata: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  if (!attempt) {
    throw new AppError("CONFLICT", "Recurring payment activation is already processing");
  }

  try {
    const owner = assertValidAddress(claimed.source_address, "sourceAddress") as Address;
    const destination = assertValidAddress(claimed.destination_address, "destinationAddress");
    const mint = assertValidAddress(claimed.token, "token") as Address;
    const tokenProgram = await resolveMintTokenProgram(rpc, mint);
    const sourceTokenAccount = await resolveSourceTokenAccount(rpc, owner, mint, tokenProgram);
    const decimals = await resolveMintDecimals(rpc, mint);
    const amountBaseUnits = parseDecimalAmount(claimed.amount, decimals);

    if (amountBaseUnits <= 0n) {
      throw new AppError("BAD_REQUEST", "Subscription amount must be greater than zero");
    }

    let plan = claimed.plan_id
      ? await subscriptionsRepo.getPlanById({
          planId: claimed.plan_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : null;

    if (!plan) {
      const createdAt = new Date().toISOString();
      plan = await subscriptionsRepo.createPlan({
        id: `psp_${crypto.randomUUID()}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ownerWalletId: input.sourceWallet.walletId,
        ownerAddress: input.sourceWallet.publicKey,
        token: claimed.token,
        amount: claimed.amount,
        periodHours: claimed.period_hours,
        programPlanId: generateProgramPlanId(),
        planPda: null,
        destinationAddress: destination,
        pullerWalletId: input.sourceWallet.walletId,
        pullerAddress: input.sourceWallet.publicKey,
        metadataUri: claimed.metadata_uri,
        status: "draft",
        createdBy: input.createdBy,
        createdAt,
        updatedAt: createdAt,
      });

      if (!plan) {
        throw new AppError("INTERNAL_ERROR", "Failed to create subscription plan");
      }
    }

    const programPlanId = parseU64String(plan.program_plan_id, "programPlanId");
    const [planPda] = await subscriptionsProgram.findPlanPda({ owner, planId: programPlanId });
    const planUpdatedAt = new Date().toISOString();

    await subscriptionsRepo.updatePlan({
      planId: plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda,
      updatedAt: planUpdatedAt,
    });
    await recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planId: plan.id,
      planPda,
      updatedAt: planUpdatedAt,
    });
    await recurringRepo.updateActivationAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planId: plan.id,
      phase: "create_plan",
      updatedAt: planUpdatedAt,
    });

    let planCreationSignature = claimed.plan_creation_signature;
    let onChainPlan = await fetchExistingPlanOrClearFailedSignature({
      rpc,
      recurringRepo,
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda,
      planCreationSignature,
      probeWithoutSignature: claimed.plan_id !== null,
    });

    if (!onChainPlan) {
      const createPlanInstruction = await subscriptionsProgram.getCreatePlanOverlayInstructionAsync(
        {
          amount: amountBaseUnits,
          destinations: [destination],
          endTs: 0n,
          metadataUri: claimed.metadata_uri ?? "",
          mint,
          owner: createNoopSigner(owner),
          periodHours: BigInt(claimed.period_hours),
          planId: programPlanId,
          pullers: [owner],
          tokenProgram,
        }
      );

      const submittedPlanCreationSignature = await sendSubscriptionInstructions({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        instructions: [createPlanInstruction],
      });
      planCreationSignature = submittedPlanCreationSignature;

      await recurringRepo.updateRecurringPaymentActivation({
        recurringPaymentId: claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planCreationSignature,
        updatedAt: new Date().toISOString(),
      });
      await recurringRepo.updateActivationAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planCreationSignature,
        updatedAt: new Date().toISOString(),
      });
      await confirmPersistedSubscriptionSignature({
        env: input.env,
        recurringRepo,
        recurringPaymentId: claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        signature: submittedPlanCreationSignature,
        field: "planCreationSignature",
      });
    }

    onChainPlan ??= await subscriptionsProgram.fetchMaybePlan(rpc, planPda, {
      commitment: "confirmed",
    });
    if (!onChainPlan.exists) {
      await clearActivationSignatureIfPresent({
        recurringRepo,
        recurringPaymentId: claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        signature: planCreationSignature,
        field: "planCreationSignature",
      });
      throw new AppError("TRANSACTION_FAILED", "Subscription plan was not found on-chain");
    }
    const planCreatedAt = onChainPlan.data.data.terms.createdAt.toString();

    await subscriptionsRepo.updatePlan({
      planId: plan.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planPda,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    await recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planCreatedAt,
      updatedAt: new Date().toISOString(),
    });

    let subscription = claimed.subscription_id
      ? await subscriptionsRepo.getSubscriptionById({
          subscriptionId: claimed.subscription_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        })
      : null;

    if (!subscription) {
      const createdAt = new Date().toISOString();
      subscription = await subscriptionsRepo.createSubscription({
        id: `psub_${crypto.randomUUID()}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planId: plan.id,
        counterpartyId: claimed.counterparty_id,
        subscriberAddress: input.sourceWallet.publicKey,
        subscriberTokenAccount: null,
        subscriptionPda: null,
        subscriptionAuthorityAddress: null,
        authorizationSignature: null,
        status: "pending_authorization",
        currentPeriodStartAt: null,
        nextCollectionDueAt: null,
        createdBy: input.createdBy,
        createdAt,
        updatedAt: createdAt,
      });

      if (!subscription) {
        throw new AppError("INTERNAL_ERROR", "Failed to create subscription");
      }
    }

    const [subscriptionAuthorityAddress] = await subscriptionsProgram.findSubscriptionAuthorityPda({
      tokenMint: mint,
      user: owner,
    });
    const [subscriptionPda] = await subscriptionsProgram.findSubscriptionDelegationPda({
      planPda,
      subscriber: owner,
    });
    const authorizationUpdatedAt = new Date().toISOString();

    await subscriptionsRepo.updateSubscription({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriberTokenAccount: sourceTokenAccount.tokenAccount,
      subscriptionPda,
      subscriptionAuthorityAddress,
      updatedAt: authorizationUpdatedAt,
    });
    await recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: subscription.id,
      subscriptionPda,
      subscriptionAuthorityAddress,
      updatedAt: authorizationUpdatedAt,
    });
    await recurringRepo.updateActivationAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionId: subscription.id,
      phase: "authorize_subscription",
      updatedAt: authorizationUpdatedAt,
    });

    let authorizationSignature = claimed.authorization_signature;
    let onChainSubscription: Awaited<
      ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>
    > | null = await fetchExistingSubscriptionOrClearFailedSignature({
      rpc,
      recurringRepo,
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      subscriptionPda,
      authorizationSignature,
      probeWithoutSignature: claimed.subscription_id !== null,
    });

    if (!onChainSubscription) {
      const subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
        rpc,
        subscriptionAuthorityAddress,
        { commitment: "confirmed" }
      );
      const expectedSubscriptionAuthorityInitId = subscriptionAuthority.exists
        ? subscriptionAuthority.data.initId
        : 0n;
      const feePayer = await createFeePaymentAdapter(input.env).getFeePayer();
      const payer = createNoopSigner(feePayer);
      const subscriber = createNoopSigner(owner);
      const initAuthorityInstruction =
        await subscriptionsProgram.getInitSubscriptionAuthorityOverlayInstructionAsync({
          owner: subscriber,
          payer,
          tokenMint: mint,
          tokenProgram,
          userAta: sourceTokenAccount.tokenAccount,
        });
      const subscribeInstruction = await subscriptionsProgram.getSubscribeOverlayInstructionAsync({
        expectedAmount: amountBaseUnits,
        expectedCreatedAt: BigInt(planCreatedAt),
        expectedPeriodHours: BigInt(claimed.period_hours),
        expectedSubscriptionAuthorityInitId,
        merchant: owner,
        payer,
        planId: programPlanId,
        subscriber,
        tokenMint: mint,
      });

      const submittedAuthorizationSignature = await sendSubscriptionInstructions({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        instructions: [initAuthorityInstruction, subscribeInstruction],
      });
      authorizationSignature = submittedAuthorizationSignature;

      await recurringRepo.updateRecurringPaymentActivation({
        recurringPaymentId: claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        authorizationSignature,
        updatedAt: new Date().toISOString(),
      });
      await recurringRepo.updateActivationAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        authorizationSignature,
        updatedAt: new Date().toISOString(),
      });
      await confirmPersistedSubscriptionSignature({
        env: input.env,
        recurringRepo,
        recurringPaymentId: claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        signature: submittedAuthorizationSignature,
        field: "authorizationSignature",
      });
    }

    onChainSubscription ??= await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
      rpc,
      subscriptionPda,
      { commitment: "confirmed" }
    );
    if (!onChainSubscription.exists) {
      await clearActivationSignatureIfPresent({
        recurringRepo,
        recurringPaymentId: claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        signature: authorizationSignature,
        field: "authorizationSignature",
      });
      throw new AppError("TRANSACTION_FAILED", "Subscription authorization was not found on-chain");
    }

    const activatedAt = new Date().toISOString();
    const nextCollectionDueAt = claimed.first_collection_at ?? activatedAt;

    await subscriptionsRepo.updateSubscription({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      authorizationSignature,
      status: "active",
      currentPeriodStartAt: activatedAt,
      nextCollectionDueAt,
      updatedAt: activatedAt,
    });

    const finalized = await recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "active",
      planId: plan.id,
      subscriptionId: subscription.id,
      planPda,
      planCreatedAt,
      planCreationSignature,
      subscriptionPda,
      subscriptionAuthorityAddress,
      authorizationSignature,
      nextCollectionDueAt,
      updatedAt: activatedAt,
    });

    if (!finalized) {
      throw new AppError("INTERNAL_ERROR", "Failed to finalize recurring payment activation");
    }

    const confirmedAttemptResults = await Promise.allSettled([
      recurringRepo.updateActivationAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "confirmed",
        phase: "finalize",
        planId: plan.id,
        subscriptionId: subscription.id,
        planCreationSignature,
        authorizationSignature,
        updatedAt: activatedAt,
      }),
    ]);
    logActivationAttemptJournalFailures(confirmedAttemptResults, {
      recurringPaymentId: claimed.id,
      attemptId: attempt.id,
    });

    return finalized;
  } catch (error) {
    const failedAt = new Date().toISOString();

    // Record failure state best-effort without masking the original activation
    // error thrown from the chain, signer, RPC, or database path above.
    const cleanupResults = await Promise.allSettled([
      recurringRepo.updateActivationAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "failed",
        error: serializeError(error),
        updatedAt: failedAt,
      }),
      resetRecurringPaymentActivationUnlessAlreadyActive({
        recurringRepo,
        recurringPaymentId: claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        updatedAt: failedAt,
      }),
    ]);
    logActivationAttemptJournalFailures(cleanupResults, {
      recurringPaymentId: claimed.id,
      attemptId: attempt.id,
    });

    throw error;
  }
}

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
import { AppError, badRequest } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import {
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

function assertRecurringPaymentTokenMint(token: string): string {
  const normalized = normalizePaymentToken(token);
  if (normalized === "SOL" || normalized === SOL_MINT) {
    throw badRequest("Recurring payments require an SPL token mint");
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
    throw badRequest(`${fieldName} must fit in an unsigned 64-bit integer`);
  }
}

async function sendSubscriptionInstructions(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  instructions: Instruction[];
  feePayer?: Address;
}): Promise<Signature> {
  const signer = await solanaServices.createOrgSigner(
    input.env,
    input.organizationId,
    input.projectId,
    input.sourceWallet.walletId
  );

  if (signer.address !== input.sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }

  const rpc = solanaRpc.createRpc(input.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const feePayment = createFeePaymentAdapter(input.env);
  const feePayer = input.feePayer ?? (await feePayment.getFeePayer());
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

async function resetRecurringPaymentActivationUnlessAlreadyActive(input: {
  recurringRepo: ReturnType<typeof createPaymentRecurringPaymentsRepository>;
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  updatedAt: string;
}): Promise<void> {
  await input.recurringRepo.resetRecurringPaymentActivationIfNotActive({
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: input.updatedAt,
  });
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
}): void {
  if (input.recurringPayment.status === "activating") {
    // PRO-1398 owns recovery for abandoned activations after crashes or partial chain state.
    throw new AppError("CONFLICT", "Recurring payment activation is already processing");
  }
  if (input.recurringPayment.status !== "pending_activation") {
    throw new AppError("CONFLICT", "Recurring payment cannot be activated from this status");
  }
  if (input.recurringPayment.source_wallet_id !== input.sourceWallet.walletId) {
    throw badRequest("Recurring payment source wallet does not match request");
  }
  if (input.recurringPayment.source_address !== input.sourceWallet.publicKey) {
    throw badRequest("Recurring payment source address does not match wallet");
  }
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
  const nowIso = new Date().toISOString();

  assertActivationPreconditions(input);

  const claimed = await recurringRepo.claimRecurringPaymentActivation({
    recurringPaymentId: input.recurringPayment.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: nowIso,
  });

  if (!claimed) {
    throw new AppError("CONFLICT", "Recurring payment activation is already processing");
  }

  let attemptedOnChainSubmission = false;

  try {
    const owner = assertValidAddress(claimed.source_address, "sourceAddress") as Address;
    const destination = assertValidAddress(claimed.destination_address, "destinationAddress");
    const mint = assertValidAddress(claimed.token, "token") as Address;
    const tokenProgram = await resolveMintTokenProgram(rpc, mint);
    const sourceTokenAccount = await resolveSourceTokenAccount(rpc, owner, mint, tokenProgram);
    const amountBaseUnits = parseDecimalAmount(claimed.amount, sourceTokenAccount.decimals);

    if (amountBaseUnits <= 0n) {
      throw badRequest("Subscription amount must be greater than zero");
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

    const createPlanInstruction = await subscriptionsProgram.getCreatePlanOverlayInstructionAsync({
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
    });
    attemptedOnChainSubmission = true;
    const planCreationSignature = await sendSubscriptionInstructions({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      instructions: [createPlanInstruction],
    });
    await recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planCreationSignature,
      updatedAt: new Date().toISOString(),
    });
    await confirmSubscriptionSignature(input.env, planCreationSignature);

    const onChainPlan = await subscriptionsProgram.fetchMaybePlan(rpc, planPda, {
      commitment: "confirmed",
    });
    if (!onChainPlan.exists) {
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
    attemptedOnChainSubmission = true;
    const authorizationSignature = await sendSubscriptionInstructions({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      instructions: [initAuthorityInstruction, subscribeInstruction],
      feePayer,
    });
    await recurringRepo.updateRecurringPaymentActivation({
      recurringPaymentId: claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      authorizationSignature,
      updatedAt: new Date().toISOString(),
    });
    await confirmSubscriptionSignature(input.env, authorizationSignature);

    const onChainSubscription = await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
      rpc,
      subscriptionPda,
      { commitment: "confirmed" }
    );
    if (!onChainSubscription.exists) {
      throw new AppError("TRANSACTION_FAILED", "Subscription authorization was not found on-chain");
    }

    const activatedAt = new Date().toISOString();
    const nextCollectionDueAt =
      claimed.first_collection_at ??
      new Date(
        new Date(activatedAt).getTime() + claimed.period_hours * 60 * 60 * 1000
      ).toISOString();

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

    return finalized;
  } catch (error) {
    if (!attemptedOnChainSubmission) {
      try {
        await resetRecurringPaymentActivationUnlessAlreadyActive({
          recurringRepo,
          recurringPaymentId: claimed.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          updatedAt: new Date().toISOString(),
        });
      } catch (resetError) {
        console.error("Failed to reset recurring payment activation after local failure", {
          error: resetError instanceof Error ? resetError.message : String(resetError),
          recurringPaymentId: claimed.id,
        });
      }
    }

    throw error;
  }
}

import {
  decideRecurringPaymentActivationTransition,
  generateProgramPlanId,
  getRecurringPaymentOperationStaleBefore,
  nextRecurringPaymentCollectionDueAt,
} from "@sdp/payments/recurring-payment-lifecycle";
import { createClusterRpc } from "@sdp/rpc/factory";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import {
  IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  isActivatingRecurringPaymentStatus,
  type PaymentRecurringPaymentActivationAttemptStage,
} from "@sdp/types/payments";
import {
  type Address,
  createNoopSigner,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token-2022";
import { getDb } from "@/db/client";
import type {
  PaymentRecurringPaymentActivationAttemptRow,
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentsRepository,
} from "@/db/repositories/payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import type {
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
  PaymentSubscriptionsRepository,
} from "@/db/repositories/payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
} from "@/db/repositories/repository-factory";
import { AppError, badRequest, conflict, internalError } from "@/lib/errors";
import { currentMandateActivator } from "@/lib/money-principal";
import { createTenantScope } from "@/lib/tenant-scope";
import {
  resolveMintTokenProgram,
  resolveSourceTokenAccountOrAta,
} from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import { createSigningService } from "@/services/domain/signing.service";
import { parseU64String } from "@/services/payment-operation.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import {
  createSponsorshipFeePayment,
  resolveProjectSponsorshipScope,
} from "@/services/sponsorship.service";
import { isDefiniteSubmissionError } from "@/services/sponsorship-submission";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import {
  assertRecurringPaymentSourceWallet,
  canonicalAttemptSignature,
  confirmSubscriptionSignature,
  createSubscriptionStepStore,
  lockLiveActivatingKey,
  parseNullableStoredSignature,
  ResumedStepUnsettledError,
  readRecurringPaymentStepIfResumed,
  recurringPaymentErrorMessage,
  refuseWhileSubscriptionAuthorityRevokes,
  requireUpdatedAttempt,
  requireUpdatedSubscription,
  type SubscriptionStep,
  savedStepSend,
  sendSubscriptionInstructions,
  subscriptionProgramMetadataUri,
} from "./shared";

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

async function getOrCreateActivationPlan(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  destination: string;
  createdBy: string | null;
}): Promise<PaymentSubscriptionPlanRow> {
  const existing = input.claimed.plan_id
    ? await input.subscriptionsRepo.getPlanById({
        planId: input.claimed.plan_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      })
    : null;

  if (existing) {
    return existing;
  }

  const createdAt = new Date().toISOString();
  const plan = await input.subscriptionsRepo.createPlan({
    id: `psp_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ownerWalletId: input.sourceWallet.walletId,
    ownerAddress: input.sourceWallet.publicKey,
    token: input.claimed.token,
    amount: input.claimed.amount,
    periodHours: input.claimed.period_hours,
    programPlanId: generateProgramPlanId(),
    planPda: null,
    destinationAddress: input.destination,
    pullerWalletId: input.sourceWallet.walletId,
    pullerAddress: input.sourceWallet.publicKey,
    metadataUri: input.claimed.metadata_uri,
    status: "draft",
    createdBy: input.createdBy,
    createdAt,
    updatedAt: createdAt,
  });

  if (!plan) {
    throw internalError("Failed to create subscription plan");
  }

  return plan;
}

async function getOrCreateActivationSubscription(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  planId: string;
  subscriberAddress: string;
  createdBy: string | null;
}): Promise<PaymentSubscriptionRow> {
  const existing = input.claimed.subscription_id
    ? await input.subscriptionsRepo.getSubscriptionById({
        subscriptionId: input.claimed.subscription_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      })
    : null;

  if (existing) {
    return existing;
  }

  const createdAt = new Date().toISOString();
  const created = await input.subscriptionsRepo.createSubscription({
    id: `psub_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    planId: input.planId,
    counterpartyId: input.claimed.counterparty_id,
    subscriberAddress: input.subscriberAddress,
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

  if (created) {
    return created;
  }

  const matched = await input.subscriptionsRepo.listSubscriptions({
    organizationId: input.organizationId,
    projectId: input.projectId,
    planId: input.planId,
    counterpartyId: input.claimed.counterparty_id,
    subscriberAddress: input.subscriberAddress,
    limit: 1,
    offset: 0,
  });

  const subscription = matched.rows[0] ?? null;
  if (!subscription) {
    throw internalError("Failed to create subscription");
  }

  return subscription;
}

async function recordActivationFailure(input: {
  env: Env;
  attempt: PaymentRecurringPaymentActivationAttemptRow;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  stage: PaymentRecurringPaymentActivationAttemptStage;
  /** A saved send is unresolved, or a live delegation still needs DB finalization. */
  sendMayLand: boolean;
  error: Error;
  failedAt: string;
}): Promise<void> {
  // A step that may be on chain keeps the attempt in flight and the schedule
  // `activating`, so the cron reads it once stale; only a definite refusal or a
  // failure before any send resets, so a reset schedule never has a delegation
  // that could still land.
  if (
    input.error instanceof ResumedStepUnsettledError ||
    (input.sendMayLand && !isDefiniteSubmissionError(input.error))
  ) {
    const recurringRepo = createPaymentRecurringPaymentsRepository(
      input.env,
      createTenantScope(input)
    );
    requireUpdatedAttempt(
      await recurringRepo.updateActivationAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: input.stage,
        error: recurringPaymentErrorMessage(input.error),
        updatedAt: input.failedAt,
      })
    );
    return;
  }
  await getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    requireUpdatedAttempt(
      await recurringRepo.updateActivationAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "failed",
        stage: input.stage,
        error: recurringPaymentErrorMessage(input.error),
        updatedAt: input.failedAt,
      })
    );

    if (input.error instanceof AppError && input.error.code === "TRANSACTION_FAILED") {
      const shouldClearAuthorizationSignature =
        input.stage === "authorize_subscription" || input.stage === "finalize";
      const planCreationSignature: string | null | undefined =
        input.stage === "create_plan" ? null : undefined;
      const authorizationSignature: string | null | undefined = shouldClearAuthorizationSignature
        ? null
        : undefined;
      const cleared = await recurringRepo.updateRecurringPaymentActivation({
        recurringPaymentId: input.claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planCreationSignature,
        authorizationSignature,
        updatedAt: input.failedAt,
      });
      if (cleared === null) throw conflict("Recurring payment activation changed concurrently");
    }

    await resetRecurringPaymentActivationUnlessAlreadyActive({
      recurringRepo,
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      updatedAt: input.failedAt,
    });
  });
}

function assertActivationPreconditions(input: {
  recurringPayment: PaymentRecurringPaymentRow;
  sourceWallet: CustodyWallet;
  nowIso: string;
}): void {
  assertRecurringPaymentSourceWallet(input.recurringPayment, input.sourceWallet);
  const transition = decideRecurringPaymentActivationTransition({
    status: input.recurringPayment.status,
    updatedAt: input.recurringPayment.updated_at,
    nowIso: input.nowIso,
  });
  if (
    transition === "already_final" ||
    transition === "claimable" ||
    transition === "recoverable"
  ) {
    return;
  }
  if (transition === "processing") {
    throw conflict("Recurring payment activation is already processing");
  }
  throw conflict("Recurring payment cannot be activated from this status");
}

async function journalActivationClaimConflict(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  recurringPayment: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  nowIso: string;
}): Promise<void> {
  try {
    await input.recurringRepo.createActivationAttempt({
      id: `prpa_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      status: "failed",
      stage: "claim",
      planCreationSignature: input.recurringPayment.plan_creation_signature,
      authorizationSignature: input.recurringPayment.authorization_signature,
      error: "Recurring payment activation is already processing",
      metadata: {},
      createdAt: input.nowIso,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    getLogger().error(
      {
        error: error instanceof Error ? error.message : String(error),
        recurring_payment_id: input.recurringPayment.id,
      },
      "Failed to journal recurring payment activation claim conflict"
    );
  }
}

async function createClaimedActivationAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  claimed: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  nowIso: string;
  recoveringStaleActivation: boolean;
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentActivationAttemptRow> {
  // A stale claim resumes the in-flight attempt under its original key, or
  // records this request's key on it when it has none. An attempt another key
  // answers for is that request's: finishing it here would leave this key with
  // no attempt, so a retry once its record expires could not find it. It is
  // refused as in flight, unstored, and the transaction rolls the claim back;
  // the cron finishes the attempt (as cancel and resume do).
  if (input.recoveringStaleActivation) {
    let existing: PaymentRecurringPaymentActivationAttemptRow | null = null;
    try {
      existing = await input.recurringRepo.getLatestActivationAttempt({
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.claimed.id,
        statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
      });
    } catch (error) {
      await resetRecurringPaymentActivationUnlessAlreadyActive({
        recurringRepo: input.recurringRepo,
        recurringPaymentId: input.claimed.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }

    if (
      existing &&
      input.idempotencyKey !== null &&
      existing.idempotency_key !== null &&
      existing.idempotency_key !== input.idempotencyKey
    ) {
      throw conflict("Recurring payment activation is already processing");
    }
    if (existing) {
      try {
        const resumed = await input.recurringRepo.updateActivationAttempt({
          attemptId: existing.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          planCreationSignature: canonicalAttemptSignature({
            attemptSignature: existing.plan_creation_signature,
            journalSignature: input.claimed.plan_creation_signature,
            label: "Recurring payment plan creation",
          }),
          authorizationSignature: canonicalAttemptSignature({
            attemptSignature: existing.authorization_signature,
            journalSignature: input.claimed.authorization_signature,
            label: "Recurring payment authorization",
          }),
          error: null,
          adoptIdempotencyKey: input.idempotencyKey,
          updatedAt: input.nowIso,
        });
        if (resumed === null) {
          throw conflict("Recurring payment activation attempt changed concurrently");
        }
        return resumed;
      } catch (error) {
        await resetRecurringPaymentActivationUnlessAlreadyActive({
          recurringRepo: input.recurringRepo,
          recurringPaymentId: input.claimed.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
    }
  }

  let attempt: PaymentRecurringPaymentActivationAttemptRow | null = null;
  try {
    attempt = await input.recurringRepo.createActivationAttempt({
      id: `prpa_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      status: "processing",
      stage: "create_plan",
      planCreationSignature: input.claimed.plan_creation_signature,
      authorizationSignature: input.claimed.authorization_signature,
      error: null,
      metadata: {},
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    await resetRecurringPaymentActivationUnlessAlreadyActive({
      recurringRepo: input.recurringRepo,
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }

  if (attempt) {
    return attempt;
  }

  await resetRecurringPaymentActivationUnlessAlreadyActive({
    recurringRepo: input.recurringRepo,
    recurringPaymentId: input.claimed.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    updatedAt: new Date().toISOString(),
  });
  throw internalError("Failed to journal recurring payment activation");
}

async function settleActiveActivationAttempt(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  recurringPayment: PaymentRecurringPaymentRow;
  organizationId: string;
  projectId: string;
  nowIso: string;
}): Promise<void> {
  try {
    const attempt = await input.recurringRepo.getLatestActivationAttempt({
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.recurringPayment.id,
      statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
    });
    if (!attempt) {
      return;
    }

    await input.recurringRepo.updateActivationAttempt({
      attemptId: attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "confirmed",
      stage: "finalize",
      planCreationSignature: canonicalAttemptSignature({
        attemptSignature: attempt.plan_creation_signature,
        journalSignature: input.recurringPayment.plan_creation_signature,
        label: "Recurring payment plan creation",
      }),
      authorizationSignature: canonicalAttemptSignature({
        attemptSignature: attempt.authorization_signature,
        journalSignature: input.recurringPayment.authorization_signature,
        label: "Recurring payment authorization",
      }),
      error: null,
      updatedAt: input.nowIso,
    });
  } catch (error) {
    getLogger().error(
      {
        error: error instanceof Error ? error.message : String(error),
        recurring_payment_id: input.recurringPayment.id,
      },
      "Failed to settle recurring payment activation attempt on active replay"
    );
  }
}

const ACTIVATION_FAILED_ON_CHAIN = "Recurring payment activation failed on-chain";

/** Confirms the plan this run sent, then reads it. */
async function confirmActivationPlan(input: {
  rpc: SolanaRpc;
  planPda: Address;
  planCreationSignature: Signature;
}) {
  await confirmSubscriptionSignature(input.planCreationSignature, ACTIVATION_FAILED_ON_CHAIN);
  return subscriptionsProgram.fetchMaybePlan(input.rpc, input.planPda, { commitment: "confirmed" });
}

/** Confirms the subscription this run sent, then reads it. */
async function confirmActivationSubscription(input: {
  rpc: SolanaRpc;
  subscriptionPda: Address;
  authorizationSignature: Signature;
}) {
  await confirmSubscriptionSignature(input.authorizationSignature, ACTIVATION_FAILED_ON_CHAIN);
  return subscriptionsProgram.fetchMaybeSubscriptionDelegation(input.rpc, input.subscriptionPda, {
    commitment: "confirmed",
  });
}

async function prepareSubscriptionAuthorityForActivation(input: {
  env: Env;
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentActivationAttemptRow;
  organizationId: string;
  projectId: string;
  rpc: SolanaRpc;
  sourceWallet: CustodyWallet;
  sourceSigner: TransactionSigner;
  sourceTokenAccount: { tokenAccount: Address; exists: boolean };
  subscriptionAuthority: Awaited<
    ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionAuthority>
  >;
  subscriptionAuthorityAddress: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
  feePayer: Address;
}) {
  if (input.subscriptionAuthority.exists && input.sourceTokenAccount.exists) {
    return input.subscriptionAuthority;
  }

  const payer = createNoopSigner(input.feePayer);
  const initAuthorityInstruction = input.subscriptionAuthority.exists
    ? null
    : await subscriptionsProgram.getInitSubscriptionAuthorityOverlayInstructionAsync({
        owner: input.sourceSigner,
        payer,
        tokenMint: input.mint,
        tokenProgram: input.tokenProgram,
        userAta: input.sourceTokenAccount.tokenAccount,
      });
  const createSourceAtaInstruction = input.sourceTokenAccount.exists
    ? null
    : getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: input.sourceTokenAccount.tokenAccount,
        owner: input.owner,
        mint: input.mint,
        tokenProgram: input.tokenProgram,
      });
  const initSignature = await sendSubscriptionInstructions({
    movement: "recurring.activate",
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    sourceSigner: input.sourceSigner,
    instructions: [
      ...(createSourceAtaInstruction ? [createSourceAtaInstruction] : []),
      ...(initAuthorityInstruction ? [initAuthorityInstruction] : []),
    ],
    feePayer: input.feePayer,
    submissionStore: createSubscriptionStepStore({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      save: async (send) => {
        requireUpdatedAttempt(
          await input.recurringRepo.updateActivationAttempt({
            attemptId: input.attempt.id,
            organizationId: input.organizationId,
            projectId: input.projectId,
            authorizationSetupSignature: send.signature,
            lastValidBlockHeight: send.lastValidBlockHeight,
            updatedAt: new Date().toISOString(),
          })
        );
      },
      rows: [
        {
          slot: { row: "activation_attempt", column: "authorization_setup_signature" },
          id: input.attempt.id,
        },
      ],
    }),
  });
  await confirmSubscriptionSignature(initSignature, "Recurring payment activation failed on-chain");

  if (!initAuthorityInstruction) {
    return input.subscriptionAuthority;
  }

  const subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
    input.rpc,
    input.subscriptionAuthorityAddress,
    { commitment: "confirmed" }
  );
  if (!subscriptionAuthority.exists) {
    throw new ResumedStepUnsettledError(
      "Subscription authority is not visible on-chain yet; retry"
    );
  }
  return subscriptionAuthority;
}

export async function activateRecurringPayment(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  recurringPayment: PaymentRecurringPaymentRow;
  createdBy: string | null;
  /**
   * Money admission (HOO-1955), run once. A fresh activation runs it before
   * the claim commits, so a refusal leaves the row untouched: the job
   * recovers a claimed activation as its mandate, and a claim must never
   * exist for a caller the waist would refuse (HOO-2099). A stale one runs it
   * after the claim, only when the plan or the authorization still has to be
   * signed; a refusal then fails the attempt and returns the row to
   * `pending_activation`, keeping any stored signatures so a later activation
   * confirms or adopts them instead of signing again.
   */
  admitStart: () => Promise<void>;
  /** The request's Idempotency-Key, written on the attempt it claims; null for the cron. */
  idempotencyKey: string | null;
}): Promise<PaymentRecurringPaymentRow> {
  const recurringRepo = createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  );
  const subscriptionsRepo = createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  );
  const rpc = createClusterRpc();
  const nowIso = new Date().toISOString();

  assertActivationPreconditions({ ...input, nowIso });
  if (input.recurringPayment.status === "active") {
    await settleActiveActivationAttempt({
      recurringRepo,
      recurringPayment: input.recurringPayment,
      organizationId: input.organizationId,
      projectId: input.projectId,
      nowIso,
    });
    return input.recurringPayment;
  }

  await createSigningService(input.env).admitRuntimeExecution(
    input.organizationId,
    input.projectId,
    input.sourceWallet.id
  );

  const recoveringStaleActivation = isActivatingRecurringPaymentStatus(
    input.recurringPayment.status
  );
  if (!recoveringStaleActivation) {
    await input.admitStart();
  }
  const activatedBy = currentMandateActivator();
  const claimResult = await getDb(input.env).transaction(async (tx) => {
    await lockLiveActivatingKey(tx, {
      activator: activatedBy,
      organizationId: input.organizationId,
      projectId: input.projectId,
      movement: "recurring.activate",
      recurringPaymentId: input.recurringPayment.id,
      custodyWalletIds: [input.sourceWallet.id],
    });
    await refuseWhileSubscriptionAuthorityRevokes(tx, {
      projectId: input.projectId,
      custodyWalletIds: [input.sourceWallet.id],
    });
    const transactionRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const claimed = await transactionRepo.claimRecurringPaymentActivation({
      recurringPaymentId: input.recurringPayment.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      updatedAt: nowIso,
      staleBefore: getRecurringPaymentOperationStaleBefore(nowIso),
      activatedBy,
    });
    if (!claimed) return null;
    const attempt = await createClaimedActivationAttempt({
      recurringRepo: transactionRepo,
      claimed,
      organizationId: input.organizationId,
      projectId: input.projectId,
      nowIso,
      recoveringStaleActivation,
      idempotencyKey: input.idempotencyKey,
    });
    return { claimed, attempt };
  });

  if (!claimResult) {
    await journalActivationClaimConflict({
      recurringRepo,
      recurringPayment: input.recurringPayment,
      organizationId: input.organizationId,
      projectId: input.projectId,
      nowIso,
    });
    throw conflict("Recurring payment activation is already processing");
  }
  const { attempt, claimed } = claimResult;

  let currentStage: PaymentRecurringPaymentActivationAttemptStage = "create_plan";
  let planCreationSignature = parseNullableStoredSignature(
    claimed.plan_creation_signature !== null
      ? claimed.plan_creation_signature
      : attempt.plan_creation_signature
  );
  let authorizationSignature = parseNullableStoredSignature(
    claimed.authorization_signature !== null
      ? claimed.authorization_signature
      : attempt.authorization_signature
  );
  // A send an earlier run saved may still land until the chain resolves its step, so a failure
  // before then keeps the attempt in flight instead of resetting over it.
  let sendMayLand = planCreationSignature !== null || authorizationSignature !== null;
  let sourceSigner: TransactionSigner | null = null;
  /**
   * The source wallet's signer for a new send, admitted and resolved on first use. A recovered
   * activation is admitted only here, after the chain has resolved every send an earlier run
   * saved, so a refusal resets a schedule that has nothing still landing.
   *
   * @returns The source wallet's signer.
   */
  const signerForNewSend = async (): Promise<TransactionSigner> => {
    if (sourceSigner !== null) return sourceSigner;
    if (recoveringStaleActivation) {
      await input.admitStart();
    }
    const signer = await createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.id,
      "recurring.activate"
    );
    if (signer.address !== input.sourceWallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match source wallet");
    }
    sourceSigner = signer;
    return signer;
  };

  try {
    const owner = assertValidAddress(claimed.source_address, "sourceAddress");
    const destination = assertValidAddress(claimed.destination_address, "destinationAddress");
    const mint = assertValidAddress(claimed.token, "token");
    const tokenProgram = await resolveMintTokenProgram(rpc, mint);
    const sourceTokenAccount = await resolveSourceTokenAccountOrAta(rpc, owner, mint, tokenProgram);
    const amountBaseUnits = parseDecimalAmount(claimed.amount, sourceTokenAccount.decimals);

    if (amountBaseUnits <= 0n) {
      throw badRequest("Subscription amount must be greater than zero");
    }

    const plan = await getOrCreateActivationPlan({
      subscriptionsRepo,
      claimed,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      destination,
      createdBy: input.createdBy,
    });

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
      stage: currentStage,
      updatedAt: new Date().toISOString(),
    });
    const planStep = {
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      rows: [
        { slot: { row: "recurring_payment", column: "plan_creation_signature" }, id: claimed.id },
        { slot: { row: "activation_attempt", column: "plan_creation_signature" }, id: attempt.id },
      ],
    } as const satisfies SubscriptionStep;
    // A step's address and signature are recorded before its send, so either one
    // is a send that may have landed, whether that run died or was reset
    // (HOO-2044); a provably refused send clears its signature.
    let onChainPlan = await readRecurringPaymentStepIfResumed(
      claimed.plan_pda !== null || planCreationSignature !== null,
      {
        rpc,
        read: (commitment) => subscriptionsProgram.fetchMaybePlan(rpc, planPda, { commitment }),
        landed: (onChain) => onChain.exists,
        savedSend: savedStepSend(planCreationSignature, attempt.last_valid_block_height),
        step: planStep,
        failureMessage: ACTIVATION_FAILED_ON_CHAIN,
        logContext: {
          recurring_payment_id: claimed.id,
          attempt_id: attempt.id,
          step: "create_plan",
        },
      }
    );
    if (!onChainPlan) {
      sendMayLand = false;
      const planSigner = await signerForNewSend();
      const createPlanInstruction = await subscriptionsProgram.getCreatePlanOverlayInstructionAsync(
        {
          amount: amountBaseUnits,
          destinations: [destination],
          endTs: 0n,
          metadataUri: subscriptionProgramMetadataUri(claimed.metadata_uri),
          mint,
          owner: planSigner,
          periodHours: BigInt(claimed.period_hours),
          planId: programPlanId,
          pullers: [owner],
          tokenProgram,
        }
      );
      planCreationSignature = await sendSubscriptionInstructions({
        movement: "recurring.activate",
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        sourceSigner: planSigner,
        instructions: [createPlanInstruction],
        submissionStore: createSubscriptionStepStore({
          ...planStep,
          save: async (send) => {
            await getDb(input.env).transaction(async (tx) => {
              const signatureUpdatedAt = new Date().toISOString();
              const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
              const updatedRecurringPayment =
                await txRecurringRepo.updateRecurringPaymentActivation({
                  recurringPaymentId: claimed.id,
                  organizationId: input.organizationId,
                  projectId: input.projectId,
                  planCreationSignature: send.signature,
                  updatedAt: signatureUpdatedAt,
                });
              if (updatedRecurringPayment === null) {
                throw conflict("Recurring payment activation changed concurrently");
              }
              requireUpdatedAttempt(
                await txRecurringRepo.updateActivationAttempt({
                  attemptId: attempt.id,
                  organizationId: input.organizationId,
                  projectId: input.projectId,
                  planCreationSignature: send.signature,
                  lastValidBlockHeight: send.lastValidBlockHeight,
                  updatedAt: signatureUpdatedAt,
                })
              );
            });
            sendMayLand = true;
          },
        }),
      });
      onChainPlan = await confirmActivationPlan({ rpc, planPda, planCreationSignature });
    }
    if (!onChainPlan.exists) {
      throw new ResumedStepUnsettledError("Subscription plan is not visible on-chain yet; retry");
    }
    sendMayLand = authorizationSignature !== null;
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

    const subscription = await getOrCreateActivationSubscription({
      subscriptionsRepo,
      claimed,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planId: plan.id,
      subscriberAddress: input.sourceWallet.publicKey,
      createdBy: input.createdBy,
    });

    currentStage = "authorize_subscription";
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
      stage: currentStage,
      updatedAt: authorizationUpdatedAt,
    });

    const authorizationStep = {
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      rows: [
        { slot: { row: "recurring_payment", column: "authorization_signature" }, id: claimed.id },
        { slot: { row: "activation_attempt", column: "authorization_signature" }, id: attempt.id },
      ],
    } as const satisfies SubscriptionStep;
    let onChainSubscription = await readRecurringPaymentStepIfResumed(
      claimed.subscription_pda !== null || authorizationSignature !== null,
      {
        rpc,
        read: (commitment) =>
          subscriptionsProgram.fetchMaybeSubscriptionDelegation(rpc, subscriptionPda, {
            commitment,
          }),
        landed: (onChain) => onChain.exists,
        savedSend: savedStepSend(authorizationSignature, attempt.last_valid_block_height),
        step: authorizationStep,
        failureMessage: ACTIVATION_FAILED_ON_CHAIN,
        logContext: {
          recurring_payment_id: claimed.id,
          attempt_id: attempt.id,
          step: "authorize_subscription",
        },
      }
    );
    if (!onChainSubscription) {
      sendMayLand = false;
      const authorizationSigner = await signerForNewSend();
      let subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
        rpc,
        subscriptionAuthorityAddress,
        { commitment: "confirmed" }
      );
      const feePayment = createSponsorshipFeePayment(
        input.env,
        await resolveProjectSponsorshipScope(input.env, {
          organizationId: input.organizationId,
          projectId: input.projectId,
          actor: { type: "wallet", id: input.sourceWallet.walletId },
        }),
        "recurring.activate"
      );
      const feePayer = await feePayment.getFeePayer();
      const payer = createNoopSigner(feePayer);

      subscriptionAuthority = await prepareSubscriptionAuthorityForActivation({
        env: input.env,
        recurringRepo,
        attempt,
        organizationId: input.organizationId,
        projectId: input.projectId,
        rpc,
        sourceWallet: input.sourceWallet,
        sourceSigner: authorizationSigner,
        sourceTokenAccount,
        subscriptionAuthority,
        subscriptionAuthorityAddress,
        owner,
        mint,
        tokenProgram,
        feePayer,
      });
      if (!subscriptionAuthority.exists) {
        throw new ResumedStepUnsettledError(
          "Subscription authority is not visible on-chain yet; retry"
        );
      }

      const subscribeInstruction = await subscriptionsProgram.getSubscribeOverlayInstructionAsync({
        expectedAmount: amountBaseUnits,
        expectedCreatedAt: BigInt(planCreatedAt),
        expectedPeriodHours: BigInt(claimed.period_hours),
        expectedSubscriptionAuthorityInitId: subscriptionAuthority.data.initId,
        merchant: owner,
        payer,
        planId: programPlanId,
        subscriber: authorizationSigner,
        tokenMint: mint,
      });
      authorizationSignature = await sendSubscriptionInstructions({
        movement: "recurring.activate",
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
        sourceSigner: authorizationSigner,
        instructions: [subscribeInstruction],
        feePayer,
        submissionStore: createSubscriptionStepStore({
          ...authorizationStep,
          save: async (send) => {
            await getDb(input.env).transaction(async (tx) => {
              const signatureUpdatedAt = new Date().toISOString();
              const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
              const updatedRecurringPayment =
                await txRecurringRepo.updateRecurringPaymentActivation({
                  recurringPaymentId: claimed.id,
                  organizationId: input.organizationId,
                  projectId: input.projectId,
                  authorizationSignature: send.signature,
                  updatedAt: signatureUpdatedAt,
                });
              if (updatedRecurringPayment === null) {
                throw conflict("Recurring payment activation changed concurrently");
              }
              requireUpdatedAttempt(
                await txRecurringRepo.updateActivationAttempt({
                  attemptId: attempt.id,
                  organizationId: input.organizationId,
                  projectId: input.projectId,
                  authorizationSignature: send.signature,
                  lastValidBlockHeight: send.lastValidBlockHeight,
                  updatedAt: signatureUpdatedAt,
                })
              );
            });
            sendMayLand = true;
          },
        }),
      });
      currentStage = "finalize";
      onChainSubscription = await confirmActivationSubscription({
        rpc,
        subscriptionPda,
        authorizationSignature,
      });
    }
    currentStage = "finalize";
    if (!onChainSubscription.exists) {
      throw new ResumedStepUnsettledError(
        "Subscription authorization is not visible on-chain yet; retry"
      );
    }
    // A live delegation stays in flight until DB finalization commits, so a
    // rolled-back write is recovered instead of becoming a DB-only cancellation.
    sendMayLand = true;

    const activatedAt = new Date().toISOString();
    const scheduleRequest =
      claimed.first_collection_at === null
        ? ({ kind: "next_period" } as const)
        : ({ kind: "requested", dueAt: claimed.first_collection_at } as const);
    let nextCollectionDueAt: string;
    switch (scheduleRequest.kind) {
      case "next_period":
        nextCollectionDueAt = nextRecurringPaymentCollectionDueAt(
          activatedAt,
          claimed.period_hours
        );
        break;
      case "requested":
        nextCollectionDueAt = scheduleRequest.dueAt;
        break;
      default: {
        const exhaustive: never = scheduleRequest;
        throw internalError(`Unsupported recurring payment schedule: ${exhaustive}`);
      }
    }

    const finalized = await getDb(input.env).transaction(async (tx) => {
      const txSubscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);
      const txRecurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
      requireUpdatedSubscription(
        await txSubscriptionsRepo.updateSubscription({
          subscriptionId: subscription.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          authorizationSignature,
          status: "active",
          currentPeriodStartAt: activatedAt,
          nextCollectionDueAt,
          updatedAt: activatedAt,
        })
      );
      const updated = await txRecurringRepo.updateRecurringPaymentActivation({
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
      if (!updated) {
        throw internalError("Failed to finalize recurring payment activation");
      }
      requireUpdatedAttempt(
        await txRecurringRepo.updateActivationAttempt({
          attemptId: attempt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          status: "confirmed",
          stage: currentStage,
          planCreationSignature,
          authorizationSignature,
          error: null,
          updatedAt: activatedAt,
        })
      );
      return updated;
    });

    return finalized;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    getLogger().error(
      {
        err: error,
        organization_id: input.organizationId,
        project_id: input.projectId,
        recurring_payment_id: claimed.id,
        attempt_id: attempt.id,
      },
      "Recurring payment activation failed"
    );
    const failedAt = new Date().toISOString();
    try {
      await recordActivationFailure({
        env: input.env,
        attempt,
        claimed,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: currentStage,
        sendMayLand,
        error,
        failedAt,
      });
    } catch (resetError) {
      getLogger().error(
        {
          error: resetError instanceof Error ? resetError.message : String(resetError),
          recurring_payment_id: claimed.id,
        },
        "Failed to journal/reset recurring payment activation after failure"
      );
    }

    throw error;
  }
}

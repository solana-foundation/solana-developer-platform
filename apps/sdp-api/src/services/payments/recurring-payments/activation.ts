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
  assertNever,
  IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  isActivatingRecurringPaymentStatus,
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
  RecurringPaymentStepSignatureSlot,
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
import { badRequest, conflict, internalError, transactionFailed } from "@/lib/errors";
import { currentMandateActivator } from "@/lib/money-principal";
import { createTenantScope } from "@/lib/tenant-scope";
import {
  resolveMintTokenProgram,
  resolveSourceTokenAccountOrAta,
} from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { createSigningService } from "@/services/domain/signing.service";
import { parseU64String } from "@/services/payment-operation.service";
import {
  resolveProjectSponsorshipScope,
  resolveSponsoredFeePayer,
} from "@/services/sponsorship.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import {
  assertRecurringPaymentSourceWallet,
  authorizationSetupEffect,
  canonicalAttemptSignature,
  delegationCreatedEffect,
  derivePlanAddresses,
  fenceRecurringPaymentStepFailure,
  insideRecurringPaymentStepPhase,
  journalInFlightRecurringPaymentAttempt,
  lazyRecurringPaymentStepSigner,
  lockLiveActivatingKey,
  parseNullableStoredSignature,
  planCreatedEffect,
  RecurringPaymentStepFailedError,
  type RecurringPaymentStepLogContext,
  type RecurringPaymentStepPhase,
  type RecurringPaymentUnwindCheck,
  ResumedStepUnsettledError,
  readRecurringPaymentStep,
  readSavedRecurringPaymentStep,
  recurringPaymentErrorMessage,
  requireUpdatedAttempt,
  requireUpdatedSubscription,
  sendRecurringPaymentStep,
  subscriptionProgramMetadataUri,
} from "./shared";

/** An activation attempt's step signature slot column. */
type ActivationAttemptStepColumn = Extract<
  RecurringPaymentStepSignatureSlot,
  { row: "activation_attempt" }
>["column"];

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

/**
 * Fails an activation whose step cannot land, in one transaction: fences the failed step's slot
 * (a dropped signature is cleared while the slot still holds it; otherwise the slot must still be
 * empty), fails the attempt (its stage stays where the run left it), and returns the schedule from
 * `activating` to `pending_activation` with no activator. The attempt write is fenced to
 * `processing` and the schedule write to `activating`. The claim stamp is no fence here: the
 * run's own schedule writes move `updated_at`.
 *
 * @param input - The run's schedule, attempt and step failure.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.claimed - The claimed schedule.
 * @param input.attempt - The run's attempt.
 * @param input.stepFailure - The step failure.
 * @throws AppError CONFLICT when the slot fence fails, the attempt is no longer `processing`, or
 *   the schedule is no longer `activating`; the transaction rolls back and the attempt stays in
 *   flight.
 */
async function failRecurringPaymentActivation(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  attempt: PaymentRecurringPaymentActivationAttemptRow;
  stepFailure: RecurringPaymentStepFailedError;
}): Promise<void> {
  const failedAt = new Date().toISOString();
  await getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    await fenceRecurringPaymentStepFailure({
      recurringRepo,
      attemptId: input.attempt.id,
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stepFailure: input.stepFailure,
      updatedAt: failedAt,
    });
    requireUpdatedAttempt(
      await recurringRepo.updateActivationAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "failed",
        error: recurringPaymentErrorMessage(input.stepFailure.failure),
        expectedStatus: "processing",
        updatedAt: failedAt,
      })
    );
    const reset = await recurringRepo.resetRecurringPaymentActivationIfNotActive({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      updatedAt: failedAt,
    });
    if (reset === null) {
      throw conflict("Recurring payment activation changed concurrently");
    }
  });
}

/**
 * Checks the chain before an activation unwinds: a schedule back in `pending_activation` never
 * carries a live delegation, which a later activation would subscribe beside. A delegation on
 * chain is the subscribe landed (its slot is empty only because a resend was refused as already
 * subscribed, or nothing was saved), so the activation continues from it and finalizes instead.
 * The delegation is derived from the activation's plan, so the check holds however far this run
 * got; with no plan recorded, no delegation can exist. Costs one plan row read and two RPC calls,
 * only on the unwind path.
 *
 * @param input - The run's plan and the failure being unwound.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPaymentId - The schedule.
 * @param input.attemptId - The run's attempt.
 * @param input.planId - The activation's plan row, or null when none is recorded.
 * @param input.stepFailure - The step failure the activation would unwind for.
 * @returns `unwind` when no delegation exists, `last_step_landed` when it does.
 * @throws ResumedStepUnsettledError when the delegation cannot be read; the attempt stays in
 *   flight.
 * @throws AppError INTERNAL_ERROR when the recorded plan row is missing.
 */
async function checkActivationUnwind(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attemptId: string;
  planId: string | null;
  stepFailure: RecurringPaymentStepFailedError;
}): Promise<RecurringPaymentUnwindCheck> {
  if (input.planId === null) {
    return "unwind";
  }
  const plan = await createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  ).getPlanById({
    planId: input.planId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (plan === null) {
    throw internalError("Recurring payment activation plan was not found");
  }
  const { owner, planPda } = await derivePlanAddresses(plan);
  const [subscriptionPda] = await subscriptionsProgram.findSubscriptionDelegationPda({
    planPda,
    subscriber: owner,
  });
  const logContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: input.recurringPaymentId,
    attempt_id: input.attemptId,
    step: "authorize_subscription",
  };
  const delegation = await readRecurringPaymentStep({
    effect: delegationCreatedEffect(subscriptionPda),
    savedSignature: null,
    lastValidBlockHeight: null,
    logContext,
  });
  switch (delegation.state) {
    case "unsent":
    case "dropped":
      return "unwind";
    case "landed":
      logEvent("warn", {
        event: "sdp_api_recurring_payment_unwind_found_step_landed",
        ...logContext,
        subscription_pda: subscriptionPda,
        ...describeError(input.stepFailure.failure),
      });
      return "last_step_landed";
    case "pending":
      logEvent("error", {
        event: "sdp_api_recurring_payment_unwind_refused_delegation_live",
        ...logContext,
        delegation_state: delegation.state,
        subscription_pda: subscriptionPda,
        ...describeError(input.stepFailure.failure),
      });
      throw new ResumedStepUnsettledError();
    default:
      return assertNever(delegation);
  }
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
      planCreationSignature: null,
      authorizationSignature: null,
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
    const existing = await input.recurringRepo.getLatestActivationAttempt({
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
    });

    if (
      existing &&
      input.idempotencyKey !== null &&
      existing.idempotency_key !== null &&
      existing.idempotency_key !== input.idempotencyKey
    ) {
      throw conflict("Recurring payment activation is already processing");
    }
    if (existing) {
      const resumed = await input.recurringRepo.updateActivationAttempt({
        attemptId: existing.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        error: null,
        adoptIdempotencyKey: input.idempotencyKey,
        updatedAt: input.nowIso,
      });
      if (resumed === null) {
        throw conflict("Recurring payment activation attempt changed concurrently");
      }
      return resumed;
    }
  }

  // A new attempt starts with every step slot empty: a step's signature is saved on the attempt
  // that sends it, and the schedule records a step only once it landed.
  const attempt = await input.recurringRepo.createActivationAttempt({
    id: `prpa_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    status: "processing",
    stage: "create_plan",
    planCreationSignature: null,
    authorizationSignature: null,
    error: null,
    metadata: {},
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    idempotencyKey: input.idempotencyKey,
  });
  if (attempt === null) {
    throw internalError("Failed to journal recurring payment activation");
  }
  return attempt;
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

/**
 * The latest step an earlier run saved a signature for on the attempt. Steps save in order and
 * each lands before the next saves, so only this one can still be in flight.
 *
 * @param attempt - The claimed attempt.
 * @returns The step's slot column, or null when none is saved.
 */
function latestSavedActivationStep(
  attempt: PaymentRecurringPaymentActivationAttemptRow
): ActivationAttemptStepColumn | null {
  if (attempt.authorization_signature !== null) return "authorization_signature";
  if (attempt.authorization_setup_signature !== null) return "authorization_setup_signature";
  if (attempt.plan_creation_signature !== null) return "plan_creation_signature";
  return null;
}

/**
 * Brings the activation's plan on chain. A plan an earlier send of this attempt saved is read;
 * one the schedule already records as created (it writes `plan_created_at` only once the plan
 * landed, with the signature that created it, null when a resend was refused as already done) is
 * taken as landed with no read; otherwise create plan goes out through the step runner and the
 * plan is read from a bank at least as new as the send's confirmation.
 *
 * @param input - The plan's terms, accounts, signer and attempt.
 * @returns The plan's on-chain creation time, and the signature that created it (null when a
 *   resend was refused as already done).
 * @throws ResumedStepUnsettledError when the plan creation is pending.
 * @throws RecurringPaymentStepFailedError when it is dropped or cannot land.
 */
async function settleActivationPlan(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  attempt: PaymentRecurringPaymentActivationAttemptRow;
  phase: RecurringPaymentStepPhase;
  rpc: SolanaRpc;
  sourceWallet: CustodyWallet;
  sourceSigner: () => Promise<TransactionSigner>;
  owner: Address;
  destination: Address;
  mint: Address;
  tokenProgram: Address;
  amountBaseUnits: bigint;
  programPlanId: bigint;
  planPda: Address;
}): Promise<{ planCreatedAt: string; planCreationSignature: Signature | null }> {
  const slot = { row: "activation_attempt", column: "plan_creation_signature" } as const;
  const logContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: input.claimed.id,
    attempt_id: input.attempt.id,
    step: "create_plan",
  };
  const effect = planCreatedEffect(input.planPda);
  const savedSignature = parseNullableStoredSignature(input.attempt.plan_creation_signature);
  if (savedSignature !== null) {
    const [planAccount] = await readSavedRecurringPaymentStep({
      phase: input.phase,
      slot,
      signature: savedSignature,
      lastValidBlockHeight: input.attempt.last_valid_block_height,
      effect,
      failureMessage: ACTIVATION_FAILED_ON_CHAIN,
      logContext,
    });
    const landedPlan = subscriptionsProgram.decodePlan(planAccount);
    if (!landedPlan.exists) {
      throw transactionFailed("Subscription plan was not found on-chain");
    }
    return {
      planCreatedAt: landedPlan.data.data.terms.createdAt.toString(),
      planCreationSignature: savedSignature,
    };
  }
  if (input.claimed.plan_created_at !== null) {
    return {
      planCreatedAt: input.claimed.plan_created_at,
      planCreationSignature: parseNullableStoredSignature(input.claimed.plan_creation_signature),
    };
  }

  const sourceSigner = await input.sourceSigner();
  const createPlanInstruction = await subscriptionsProgram.getCreatePlanOverlayInstructionAsync({
    amount: input.amountBaseUnits,
    destinations: [input.destination],
    endTs: 0n,
    metadataUri: subscriptionProgramMetadataUri(input.claimed.metadata_uri),
    mint: input.mint,
    owner: sourceSigner,
    periodHours: BigInt(input.claimed.period_hours),
    planId: input.programPlanId,
    pullers: [input.owner],
    tokenProgram: input.tokenProgram,
  });
  const settled = await sendRecurringPaymentStep({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    attemptId: input.attempt.id,
    movement: "recurring.activate",
    sourceWallet: input.sourceWallet,
    sourceSigner,
    instructions: [createPlanInstruction],
    slot,
    effect,
    alreadyDone: {
      code: subscriptionsProgram.SUBSCRIPTIONS_ERROR__PLAN_ALREADY_EXISTS,
      notLanded: "pending",
    },
    onFailure: { outcome: "unwind" },
    failureMessage: ACTIVATION_FAILED_ON_CHAIN,
    logContext,
  });
  const onChainPlan =
    settled.state === "landed"
      ? subscriptionsProgram.decodePlan(settled.accounts[0])
      : await subscriptionsProgram.fetchMaybePlan(input.rpc, input.planPda, {
          commitment: "confirmed",
          minContextSlot: settled.confirmedSlot,
        });
  if (!onChainPlan.exists) {
    throw transactionFailed("Subscription plan was not found on-chain");
  }
  return {
    planCreatedAt: onChainPlan.data.data.terms.createdAt.toString(),
    planCreationSignature: settled.signature,
  };
}

/**
 * The fee payer an activation's sends name, resolved from the project's sponsor.
 *
 * @param input - The schedule's tenant and source wallet.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The wallet the sponsorship is scoped to.
 * @returns The fee payer's address.
 */
async function resolveActivationFeePayer(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
}): Promise<Address> {
  return resolveSponsoredFeePayer(
    input.env,
    await resolveProjectSponsorshipScope(input.env, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { type: "wallet", id: input.sourceWallet.walletId },
    })
  );
}

/**
 * Makes sure the source wallet's subscription authority and token account exist and delegate to
 * each other before subscribe. A setup an earlier send of this attempt saved is read first, as
 * every other step is, so a pending or dropped one reads nothing else; otherwise the authority is
 * read, a wallet that already has both skips the step, and one missing either sends the setup
 * (the token account create when it is missing, then the authority init, always) through the step
 * runner. The skip takes an existing authority and token account as set up without reading the
 * token account's delegate (the setup effect does); a revoked approval there is not repaired.
 *
 * @param input - The setup's accounts, signer, fee payer and attempt.
 * @returns The subscription authority as read after setup.
 * @throws ResumedStepUnsettledError when the setup is pending.
 * @throws RecurringPaymentStepFailedError when the setup is dropped or cannot land.
 */
async function prepareSubscriptionAuthorityForActivation(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attempt: PaymentRecurringPaymentActivationAttemptRow;
  phase: RecurringPaymentStepPhase;
  rpc: SolanaRpc;
  sourceWallet: CustodyWallet;
  sourceSigner: () => Promise<TransactionSigner>;
  sourceTokenAccount: { tokenAccount: Address; exists: boolean };
  subscriptionAuthorityAddress: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
  feePayer: () => Promise<Address>;
}) {
  const slot = { row: "activation_attempt", column: "authorization_setup_signature" } as const;
  input.phase.step = slot;
  const logContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: input.recurringPaymentId,
    attempt_id: input.attempt.id,
    step: "authorization_setup",
  };
  const effect = authorizationSetupEffect({
    subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
    sourceTokenAccount: input.sourceTokenAccount.tokenAccount,
    owner: input.owner,
    mint: input.mint,
    tokenProgram: input.tokenProgram,
  });
  const savedSetupSignature = parseNullableStoredSignature(
    input.attempt.authorization_setup_signature
  );
  if (savedSetupSignature !== null) {
    const accounts = await readSavedRecurringPaymentStep({
      phase: input.phase,
      slot,
      signature: savedSetupSignature,
      lastValidBlockHeight: input.attempt.last_valid_block_height,
      effect,
      failureMessage: ACTIVATION_FAILED_ON_CHAIN,
      logContext,
    });
    return subscriptionsProgram.decodeSubscriptionAuthority(accounts[0]);
  }
  const existingAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
    input.rpc,
    input.subscriptionAuthorityAddress,
    { commitment: "confirmed" }
  );
  if (existingAuthority.exists && input.sourceTokenAccount.exists) {
    return existingAuthority;
  }

  const feePayer = await input.feePayer();
  const sourceSigner = await input.sourceSigner();
  const payer = createNoopSigner(feePayer);
  // The init always goes out: it is idempotent on an existing authority (its `initId` stays) and
  // re-runs the token account's Approve, which the setup effect requires.
  const initAuthorityInstruction =
    await subscriptionsProgram.getInitSubscriptionAuthorityOverlayInstructionAsync({
      owner: sourceSigner,
      payer,
      tokenMint: input.mint,
      tokenProgram: input.tokenProgram,
      userAta: input.sourceTokenAccount.tokenAccount,
    });
  const instructions = input.sourceTokenAccount.exists
    ? [initAuthorityInstruction]
    : [
        getCreateAssociatedTokenIdempotentInstruction({
          payer,
          ata: input.sourceTokenAccount.tokenAccount,
          owner: input.owner,
          mint: input.mint,
          tokenProgram: input.tokenProgram,
        }),
        initAuthorityInstruction,
      ];
  const settled = await sendRecurringPaymentStep({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    attemptId: input.attempt.id,
    movement: "recurring.activate",
    sourceWallet: input.sourceWallet,
    sourceSigner,
    feePayer,
    instructions,
    slot,
    effect,
    alreadyDone: null,
    onFailure: { outcome: "unwind" },
    failureMessage: ACTIVATION_FAILED_ON_CHAIN,
    logContext,
  });
  if (settled.state === "landed") {
    return subscriptionsProgram.decodeSubscriptionAuthority(settled.accounts[0]);
  }
  if (existingAuthority.exists) {
    return existingAuthority;
  }

  const subscriptionAuthority = await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
    input.rpc,
    input.subscriptionAuthorityAddress,
    { commitment: "confirmed", minContextSlot: settled.confirmedSlot }
  );
  if (!subscriptionAuthority.exists) {
    throw transactionFailed("Subscription authority was not found on-chain");
  }
  return subscriptionAuthority;
}

/**
 * Brings the activation's delegation on chain. A subscribe an earlier send of this attempt saved
 * is read; otherwise the wallet's setup runs when it needs one, then subscribe goes out through
 * the step runner. A confirmed subscribe is landed (D1): nothing reads the delegation after it.
 *
 * @param input - The subscribe's accounts, terms, signer and attempt.
 * @returns The subscribe's signature, or null when a resend was refused as already subscribed.
 * @throws ResumedStepUnsettledError when the setup or subscribe is pending.
 * @throws RecurringPaymentStepFailedError when either is dropped or cannot land.
 */
async function settleActivationSubscription(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  attempt: PaymentRecurringPaymentActivationAttemptRow;
  phase: RecurringPaymentStepPhase;
  rpc: SolanaRpc;
  sourceWallet: CustodyWallet;
  sourceSigner: () => Promise<TransactionSigner>;
  sourceTokenAccount: { tokenAccount: Address; exists: boolean };
  subscriptionAuthorityAddress: Address;
  subscriptionPda: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
  amountBaseUnits: bigint;
  planCreatedAt: string;
  programPlanId: bigint;
}): Promise<Signature | null> {
  const slot = { row: "activation_attempt", column: "authorization_signature" } as const;
  const logContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: input.claimed.id,
    attempt_id: input.attempt.id,
    step: "authorize_subscription",
  };
  const effect = delegationCreatedEffect(input.subscriptionPda);
  const savedSignature = parseNullableStoredSignature(input.attempt.authorization_signature);
  if (savedSignature !== null) {
    await readSavedRecurringPaymentStep({
      phase: input.phase,
      slot,
      signature: savedSignature,
      lastValidBlockHeight: input.attempt.last_valid_block_height,
      effect,
      failureMessage: ACTIVATION_FAILED_ON_CHAIN,
      logContext,
    });
    return savedSignature;
  }
  // The unwind check found the delegation on chain: subscribe landed with no signature this
  // attempt holds, so nothing is set up or sent.
  if (input.phase.lastStepLanded) {
    return null;
  }

  let feePayerResolution: Promise<Address> | null = null;
  const resolveFeePayer = () => {
    if (feePayerResolution === null) {
      feePayerResolution = resolveActivationFeePayer(input);
    }
    return feePayerResolution;
  };
  const subscriptionAuthority = await prepareSubscriptionAuthorityForActivation({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    attempt: input.attempt,
    phase: input.phase,
    rpc: input.rpc,
    sourceWallet: input.sourceWallet,
    sourceSigner: input.sourceSigner,
    sourceTokenAccount: input.sourceTokenAccount,
    subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
    owner: input.owner,
    mint: input.mint,
    tokenProgram: input.tokenProgram,
    feePayer: resolveFeePayer,
  });
  input.phase.step = slot;
  if (!subscriptionAuthority.exists) {
    throw transactionFailed("Subscription authority was not found on-chain");
  }

  const feePayer = await resolveFeePayer();
  const sourceSigner = await input.sourceSigner();
  const subscribeInstruction = await subscriptionsProgram.getSubscribeOverlayInstructionAsync({
    expectedAmount: input.amountBaseUnits,
    expectedCreatedAt: BigInt(input.planCreatedAt),
    expectedPeriodHours: BigInt(input.claimed.period_hours),
    expectedSubscriptionAuthorityInitId: subscriptionAuthority.data.initId,
    merchant: input.owner,
    payer: createNoopSigner(feePayer),
    planId: input.programPlanId,
    subscriber: sourceSigner,
    tokenMint: input.mint,
  });
  const settled = await sendRecurringPaymentStep({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.claimed.id,
    attemptId: input.attempt.id,
    movement: "recurring.activate",
    sourceWallet: input.sourceWallet,
    sourceSigner,
    feePayer,
    instructions: [subscribeInstruction],
    slot,
    effect,
    alreadyDone: {
      code: subscriptionsProgram.SUBSCRIPTIONS_ERROR__ALREADY_SUBSCRIBED,
      notLanded: "pending",
    },
    onFailure: { outcome: "unwind" },
    failureMessage: ACTIVATION_FAILED_ON_CHAIN,
    logContext,
  });
  return settled.signature;
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
   * after the claim, just before its first new signature; a refusal then
   * fails the attempt back to `pending_activation` like any step that cannot
   * be sent, and a run that only reads landed or pending steps never asks.
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
  const phase: RecurringPaymentStepPhase = {
    unreadSavedStep: latestSavedActivationStep(attempt),
    step: { row: "activation_attempt", column: "plan_creation_signature" },
    lastStepLanded: false,
  };
  const sourceSigner = lazyRecurringPaymentStepSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    movement: "recurring.activate",
    admitRecovered: recoveringStaleActivation ? input.admitStart : null,
    logContext: { recurring_payment_id: claimed.id, attempt_id: attempt.id },
  });
  let activationPlanId = claimed.plan_id;

  const activationSteps = async () => {
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
    activationPlanId = plan.id;

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
      stage: "create_plan",
      updatedAt: new Date().toISOString(),
    });

    const { planCreatedAt, planCreationSignature } = await settleActivationPlan({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      claimed,
      attempt,
      phase,
      rpc,
      sourceWallet: input.sourceWallet,
      sourceSigner,
      owner,
      destination,
      mint,
      tokenProgram,
      amountBaseUnits,
      programPlanId,
      planPda,
    });
    phase.step = { row: "activation_attempt", column: "authorization_setup_signature" };

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
      planCreationSignature,
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
      stage: "authorize_subscription",
      updatedAt: authorizationUpdatedAt,
    });

    const authorizationSignature = await settleActivationSubscription({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      claimed,
      attempt,
      phase,
      rpc,
      sourceWallet: input.sourceWallet,
      sourceSigner,
      sourceTokenAccount,
      subscriptionAuthorityAddress,
      subscriptionPda,
      owner,
      mint,
      tokenProgram,
      amountBaseUnits,
      planCreatedAt,
      programPlanId,
    });

    return {
      plan,
      planPda,
      planCreatedAt,
      planCreationSignature,
      subscription,
      subscriptionPda,
      subscriptionAuthorityAddress,
      authorizationSignature,
    };
  };

  try {
    const activation = await insideRecurringPaymentStepPhase(
      phase,
      activationSteps,
      (stepFailure) =>
        checkActivationUnwind({
          env: input.env,
          organizationId: input.organizationId,
          projectId: input.projectId,
          recurringPaymentId: claimed.id,
          attemptId: attempt.id,
          planId: activationPlanId,
          stepFailure,
        })
    );

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
          subscriptionId: activation.subscription.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          authorizationSignature: activation.authorizationSignature,
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
        planId: activation.plan.id,
        subscriptionId: activation.subscription.id,
        planPda: activation.planPda,
        planCreatedAt: activation.planCreatedAt,
        planCreationSignature: activation.planCreationSignature,
        subscriptionPda: activation.subscriptionPda,
        subscriptionAuthorityAddress: activation.subscriptionAuthorityAddress,
        authorizationSignature: activation.authorizationSignature,
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
          stage: "finalize",
          planCreationSignature: activation.planCreationSignature,
          authorizationSignature: activation.authorizationSignature,
          error: null,
          expectedStatus: "processing",
          updatedAt: activatedAt,
        })
      );
      return updated;
    });

    return finalized;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const stepFailure = error instanceof RecurringPaymentStepFailedError ? error : null;
    getLogger().error(
      {
        err: stepFailure === null ? error : stepFailure.failure,
        organization_id: input.organizationId,
        project_id: input.projectId,
        recurring_payment_id: claimed.id,
        attempt_id: attempt.id,
      },
      "Recurring payment activation failed"
    );
    if (stepFailure !== null) {
      await failRecurringPaymentActivation({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        claimed,
        attempt,
        stepFailure,
      });
      throw stepFailure.failure;
    }
    // Anything else may leave a step in flight: the attempt keeps its status and records only
    // the error, so a concurrent finalize is never flipped back.
    await journalInFlightRecurringPaymentAttempt({
      error,
      write: () =>
        recurringRepo.updateActivationAttempt({
          attemptId: attempt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          error: recurringPaymentErrorMessage(error),
          expectedStatus: "processing",
          updatedAt: new Date().toISOString(),
        }),
      logContext: { recurring_payment_id: claimed.id, attempt_id: attempt.id },
    });

    throw error;
  }
}

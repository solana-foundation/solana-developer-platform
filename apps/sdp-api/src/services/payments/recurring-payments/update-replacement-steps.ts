import { generateProgramPlanId } from "@sdp/payments/recurring-payment-lifecycle";
import { createClusterRpc } from "@sdp/rpc/factory";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import {
  assertNever,
  IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  isUpdatingRecurringPaymentStatus,
} from "@sdp/types/payments";
import type { Address, MaybeEncodedAccount, Signature, TransactionSigner } from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import type {
  PaymentRecurringPaymentsRepository,
  PaymentRecurringPaymentUpdateAttemptRow,
} from "@/db/repositories/payment-recurring-payments.repository";
import {
  generatePaymentSubscriptionId,
  generatePaymentSubscriptionPlanId,
  type PaymentSubscriptionPlanRow,
  type PaymentSubscriptionRow,
  type PaymentSubscriptionsRepository,
} from "@/db/repositories/payment-subscriptions.repository";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
} from "@/db/repositories/repository-factory";
import { conflict, internalError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { describeError, logEvent } from "@/runtime/money-path-events";
import type { Env } from "@/types/env";
import {
  delegationCanceledEffect,
  delegationCreatedEffect,
  derivePlanAddresses,
  parseNullableStoredSignature,
  planCreatedEffect,
  type RecurringPaymentSourceWallet,
  RecurringPaymentStepFailedError,
  type RecurringPaymentStepLogContext,
  type RecurringPaymentStepPhase,
  type RecurringPaymentUnwindCheck,
  ResumedStepUnsettledError,
  readRecurringPaymentStep,
  requireUpdatedAttempt,
  sendRecurringPaymentStep,
  subscriptionProgramMetadataUri,
} from "./shared";
import { authorizeRecurringPaymentSubscription } from "./subscription-authority";
import {
  refuseCronUpdateStepSend,
  type UpdateAttemptStepColumn,
  type UpdateAttemptStepSlot,
} from "./update-attempt";
import type { ClaimedUpdateStarts, RecurringPaymentUpdateTerms } from "./update-request";

/**
 * Checks the chain before a replacement unwinds. A replacement never returns to `active` on the
 * old mandate while the new delegation exists: both would be live. A new delegation on chain is
 * the authorization landed (its slot is empty only because a resend was refused as already
 * subscribed, or nothing was saved), so the update continues from it to the old cancel instead.
 * The new delegation is derived from the attempt's replacement plan, so the check holds however
 * far this run got; with no replacement plan recorded, no new delegation can exist. Costs one plan
 * row read and two RPC calls, only on the unwind path.
 *
 * @param input - The run's attempt and the failure being unwound.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.attempt - The run's attempt as it stands.
 * @param input.cause - The step failure, or the earlier step still pending, the flow would
 *   unwind or wait for.
 * @returns `unwind` when no new delegation exists, `last_step_landed` when it does.
 * @throws ResumedStepUnsettledError when the new delegation cannot be read; the attempt stays in
 *   flight.
 * @throws AppError INTERNAL_ERROR when the recorded replacement plan row is missing.
 */
export async function checkReplacementUnwind(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  cause: Error;
}): Promise<RecurringPaymentUnwindCheck> {
  if (input.attempt.new_plan_id === null) {
    return "unwind";
  }
  const plan = await createPaymentSubscriptionsRepository(
    input.env,
    createTenantScope(input)
  ).getPlanById({
    planId: input.attempt.new_plan_id,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (plan === null) {
    throw internalError("Recurring payment replacement plan was not found");
  }
  const { owner, planPda } = await derivePlanAddresses(plan);
  const [subscriptionPda] = await subscriptionsProgram.findSubscriptionDelegationPda({
    planPda,
    subscriber: owner,
  });
  const logContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: input.attempt.recurring_payment_id,
    attempt_id: input.attempt.id,
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
        ...describeError(input.cause),
      });
      return "last_step_landed";
    case "pending":
      logEvent("error", {
        event: "sdp_api_recurring_payment_unwind_refused_delegation_live",
        ...logContext,
        delegation_state: delegation.state,
        subscription_pda: subscriptionPda,
        ...describeError(input.cause),
      });
      throw new ResumedStepUnsettledError();
    default:
      return assertNever(delegation);
  }
}

/**
 * Clears a dropped old-subscription cancel's saved signature, only while its slot still holds
 * it, and logs it, so the next send of the cancel starts from an empty slot.
 *
 * @param input - The dropped cancel.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPaymentId - The schedule.
 * @param input.attemptId - The update attempt.
 * @param input.signature - The dropped cancel's saved signature.
 * @param input.oldSubscriptionPda - The old delegation's address.
 * @param input.logContext - What the step's logs name.
 * @throws AppError CONFLICT when the slot no longer holds the signature.
 */
export async function clearDroppedOldCancel(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attemptId: string;
  signature: Signature;
  oldSubscriptionPda: Address;
  logContext: RecurringPaymentStepLogContext;
}): Promise<void> {
  const cleared = await createPaymentRecurringPaymentsRepository(
    input.env,
    createTenantScope(input)
  ).clearStepSignature({
    slot: { row: "update_attempt", column: "old_cancel_signature" },
    id: input.attemptId,
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    signature: input.signature,
    updatedAt: new Date().toISOString(),
  });
  if (!cleared) {
    throw conflict("Recurring payment step signature changed concurrently");
  }
  logEvent("error", {
    event: "sdp_api_recurring_payment_old_cancel_dropped",
    ...input.logContext,
    signature: input.signature,
    old_subscription_pda: input.oldSubscriptionPda,
  });
}

/**
 * Reads, for the cron, a replacement's plan creation that has no saved signature while a later
 * step of the attempt does. A later step saves only after this one landed, so the plan landed
 * through a send refused as already done, which cleared its slot; the cron sends nothing new, so
 * it reads the plan's effect instead of sending again. Costs two RPC calls.
 *
 * @param input - The plan's address, slot and what the logs name.
 * @param input.planPda - The replacement plan's address.
 * @param input.slot - The plan creation's signature slot.
 * @param input.logContext - What the step's logs name.
 * @returns The landed plan's effect accounts.
 * @throws ResumedStepUnsettledError when the read is pending.
 * @throws RecurringPaymentStepFailedError with the cron's refusal when the plan is not on chain.
 */
export async function readUnsentPlanCreationForCron(input: {
  planPda: Address;
  slot: UpdateAttemptStepSlot;
  logContext: RecurringPaymentStepLogContext;
}): Promise<readonly MaybeEncodedAccount[]> {
  const step = await readRecurringPaymentStep({
    effect: planCreatedEffect(input.planPda),
    savedSignature: null,
    lastValidBlockHeight: null,
    logContext: input.logContext,
  });
  switch (step.state) {
    case "landed":
      return step.accounts;
    case "pending":
      throw new ResumedStepUnsettledError();
    case "unsent":
    case "dropped":
      throw new RecurringPaymentStepFailedError({
        failure: refuseCronUpdateStepSend(input.logContext),
        slot: input.slot,
        droppedSignature: null,
      });
    default:
      return assertNever(step);
  }
}

export async function getOrCreateReplacementPlan(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
  resolved: RecurringPaymentUpdateTerms;
  /** The destination a plan this run creates pays; the cron's refuses, since it creates none. */
  planCreationDestination: () => Address;
  createdBy: string | null;
}): Promise<PaymentSubscriptionPlanRow> {
  if (input.attempt.new_plan_id) {
    const existing = await input.subscriptionsRepo.getPlanById({
      planId: input.attempt.new_plan_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (existing) {
      return existing;
    }
  }

  const now = new Date().toISOString();
  const plan = await input.subscriptionsRepo.createPlan({
    id: generatePaymentSubscriptionPlanId(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    ownerWalletId: input.sourceWallet.walletId,
    ownerAddress: input.sourceWallet.publicKey,
    token: input.resolved.token,
    amount: input.resolved.amount,
    periodHours: input.resolved.periodHours,
    programPlanId: generateProgramPlanId(),
    planPda: null,
    destinationAddress: input.planCreationDestination(),
    pullerWalletId: input.sourceWallet.walletId,
    pullerAddress: input.sourceWallet.publicKey,
    metadataUri: input.resolved.metadataUri,
    status: "draft",
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!plan) {
    throw internalError("Failed to create replacement subscription plan");
  }

  return plan;
}

export async function getOrCreateReplacementSubscription(input: {
  subscriptionsRepo: PaymentSubscriptionsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  organizationId: string;
  projectId: string;
  planId: string;
  resolved: RecurringPaymentUpdateTerms;
  createdBy: string | null;
}): Promise<PaymentSubscriptionRow> {
  if (input.attempt.new_subscription_id) {
    const existing = await input.subscriptionsRepo.getSubscriptionById({
      subscriptionId: input.attempt.new_subscription_id,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (existing) {
      return existing;
    }
  }

  const now = new Date().toISOString();
  const subscription = await input.subscriptionsRepo.createSubscription({
    id: generatePaymentSubscriptionId(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    planId: input.planId,
    counterpartyId: input.resolved.counterpartyId,
    subscriberAddress: input.resolved.sourceWallet.publicKey,
    subscriberTokenAccount: null,
    subscriptionPda: null,
    subscriptionAuthorityAddress: null,
    authorizationSignature: null,
    status: "pending_authorization",
    currentPeriodStartAt: null,
    nextCollectionDueAt: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  if (!subscription) {
    throw internalError("Failed to create replacement subscription");
  }

  return subscription;
}

/**
 * The latest unwinding step of a replacement an earlier run saved a signature for: the only one
 * whose send may still be in flight.
 *
 * @param attempt - The claimed attempt.
 * @returns The step's slot column, or null when none is saved.
 */
export function latestSavedReplacementStep(
  attempt: PaymentRecurringPaymentUpdateAttemptRow
): UpdateAttemptStepColumn | null {
  if (attempt.authorization_signature !== null) return "authorization_signature";
  if (attempt.authorization_setup_signature !== null) return "authorization_setup_signature";
  if (attempt.plan_creation_signature !== null) return "plan_creation_signature";
  return null;
}

/**
 * Reads the old subscription's cancel an earlier run saved a signature for. A dropped cancel is
 * cleared, only while its slot still holds the signature, and logged, for the caller to send it
 * again: the new mandate is live, so the cancel never unwinds. A saved cancel never reads as
 * unsent; the reader's unsent arm is kept in flight with pending.
 *
 * @param input - The saved cancel.
 * @param input.env - The environment.
 * @param input.attempt - The run's attempt.
 * @param input.signature - The saved cancel signature.
 * @param input.oldSubscriptionPda - The old delegation's address.
 * @param input.logContext - What the step's logs name.
 * @returns Whether the cancel landed.
 * @throws ResumedStepUnsettledError when the cancel is pending.
 * @throws AppError CONFLICT when the slot no longer holds the dropped signature.
 */
export async function readSavedOldCancel(input: {
  env: Env;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  signature: Signature;
  oldSubscriptionPda: Address;
  logContext: RecurringPaymentStepLogContext;
}): Promise<boolean> {
  const step = await readRecurringPaymentStep({
    effect: delegationCanceledEffect(input.oldSubscriptionPda),
    savedSignature: input.signature,
    lastValidBlockHeight: input.attempt.last_valid_block_height,
    logContext: input.logContext,
  });
  switch (step.state) {
    case "landed":
      return true;
    case "unsent":
    case "pending":
      throw new ResumedStepUnsettledError();
    case "dropped":
      await clearDroppedOldCancel({
        env: input.env,
        organizationId: input.attempt.organization_id,
        projectId: input.attempt.project_id,
        recurringPaymentId: input.attempt.recurring_payment_id,
        attemptId: input.attempt.id,
        signature: input.signature,
        oldSubscriptionPda: input.oldSubscriptionPda,
        logContext: input.logContext,
      });
      return false;
    default:
      return assertNever(step);
  }
}

/**
 * Sends a replacement's plan creation: its stage, then create plan through the step runner, and
 * reads the plan it created.
 *
 * @param input - The plan's terms, accounts, signer and attempt.
 * @returns The attempt after its stage write, the plan creation signature (null when the send was
 *   refused as already done) and the plan as read.
 * @throws ResumedStepUnsettledError when the plan creation is pending.
 * @throws RecurringPaymentStepFailedError when it cannot land.
 */
export async function sendReplacementPlanCreation(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  sourceWallet: RecurringPaymentSourceWallet;
  sourceSigner: TransactionSigner;
  resolved: RecurringPaymentUpdateTerms;
  owner: Address;
  destination: Address;
  mint: Address;
  tokenProgram: Address;
  amountBaseUnits: bigint;
  programPlanId: bigint;
  planPda: Address;
  slot: UpdateAttemptStepSlot;
  failureMessage: string;
  logContext: RecurringPaymentStepLogContext;
}) {
  const attempt = requireUpdatedAttempt(
    await input.recurringRepo.updateUpdateAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: "create_plan",
      updatedAt: new Date().toISOString(),
    })
  );
  const createPlanInstruction = await subscriptionsProgram.getCreatePlanOverlayInstructionAsync({
    amount: input.amountBaseUnits,
    destinations: [input.destination],
    endTs: 0n,
    metadataUri: subscriptionProgramMetadataUri(input.resolved.metadataUri),
    mint: input.mint,
    owner: input.sourceSigner,
    periodHours: BigInt(input.resolved.periodHours),
    planId: input.programPlanId,
    pullers: [input.owner],
    tokenProgram: input.tokenProgram,
  });
  const settled = await sendRecurringPaymentStep({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: attempt.recurring_payment_id,
    attemptId: attempt.id,
    movement: "recurring.update",
    sourceWallet: input.sourceWallet,
    sourceSigner: input.sourceSigner,
    instructions: [createPlanInstruction],
    slot: input.slot,
    effect: planCreatedEffect(input.planPda),
    alreadyDone: {
      code: subscriptionsProgram.SUBSCRIPTIONS_ERROR__PLAN_ALREADY_EXISTS,
      notLanded: "pending",
    },
    onFailure: { outcome: "unwind" },
    failureMessage: input.failureMessage,
    logContext: input.logContext,
  });
  const onChainPlan =
    settled.state === "landed"
      ? subscriptionsProgram.decodePlan(settled.accounts[0])
      : await subscriptionsProgram.fetchMaybePlan(createClusterRpc(), input.planPda, {
          commitment: "confirmed",
          minContextSlot: settled.confirmedSlot,
        });
  return { attempt, signature: settled.signature, onChainPlan };
}

/**
 * Sends a replacement's authorization: its stage, then the source wallet's setup when it needs one
 * and subscribe to the new plan (`authorizeRecurringPaymentSubscription`), each through the step
 * runner. A subscribe refused as already subscribed whose re-read shows the delegation goes on to
 * the old cancel in this run with no signature saved; a later run finds the slot empty, sends
 * again, and re-derives landed from the chain the same way, and an unwind first checks the chain
 * for the delegation.
 *
 * @param input - The authorization's accounts, signers, terms and attempt.
 * @returns The attempt after its stage write, and the authorization signature (null when the
 *   subscribe was refused as already done).
 * @throws ResumedStepUnsettledError when the setup or subscribe is pending.
 * @throws RecurringPaymentStepFailedError when either cannot land.
 */
export async function sendReplacementAuthorization(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringRepo: PaymentRecurringPaymentsRepository;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  phase: RecurringPaymentStepPhase;
  sourceWallet: RecurringPaymentSourceWallet;
  stepSigner: () => Promise<TransactionSigner>;
  sourceTokenAccount: Address;
  subscriptionAuthorityAddress: Address;
  subscriptionPda: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
  amountBaseUnits: bigint;
  planCreatedAt: string;
  periodHours: number;
  programPlanId: bigint;
}): Promise<{ attempt: PaymentRecurringPaymentUpdateAttemptRow; signature: Signature | null }> {
  // With no setup saved to read first, the subscribe needs a new send: its signer resolves, or the
  // cron refuses, before the stage write, the authority read and the fee payer.
  if (input.attempt.authorization_setup_signature === null) {
    await input.stepSigner();
  }
  const attempt = requireUpdatedAttempt(
    await input.recurringRepo.updateUpdateAttempt({
      attemptId: input.attempt.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      stage: "authorize_subscription",
      updatedAt: new Date().toISOString(),
    })
  );
  const signature = await authorizeRecurringPaymentSubscription({
    flow: "update",
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: attempt.recurring_payment_id,
    attempt,
    phase: input.phase,
    rpc: createClusterRpc(),
    sourceWallet: input.sourceWallet,
    sourceSigner: input.stepSigner,
    sourceTokenAccount: input.sourceTokenAccount,
    subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
    subscriptionPda: input.subscriptionPda,
    owner: input.owner,
    mint: input.mint,
    tokenProgram: input.tokenProgram,
    amountBaseUnits: input.amountBaseUnits,
    planCreatedAt: input.planCreatedAt,
    periodHours: input.periodHours,
    programPlanId: input.programPlanId,
  });
  return { attempt, signature };
}

/**
 * The destination a replacement's new plan pays, when the run creates the plan: the one the
 * request resolved. The cron creates no plan and sends no plan creation, so it is refused
 * (`refuseCronUpdateStepSend`), which fails the update back to `active`.
 *
 * @param starts - Whether the run may send new steps.
 * @param logContext - The schedule and attempt the refusal's log names.
 * @returns The destination.
 * @throws AppError CONFLICT for the cron.
 */
export function replacementPlanCreationDestination(
  starts: ClaimedUpdateStarts,
  logContext: Pick<RecurringPaymentStepLogContext, "recurring_payment_id" | "attempt_id">
): Address {
  if (!starts.allowed) {
    throw refuseCronUpdateStepSend(logContext);
  }
  return assertValidAddress(starts.destinationAddress, "destinationAddress");
}

/**
 * The destination a replacement finalizes on. A request finalizes on the destination it resolved,
 * which its own plan creation paid. The cron resumes an update a request started, and the plan
 * row is editable (`PATCH /subscription-plans/:planId`) while the chain is not, so the cron reads
 * the destination from the landed plan account and refuses a plan the chain shows owned by
 * another wallet than the one the row names.
 *
 * @param starts - Whether the run may send new steps (a request) or not (the cron).
 * @param plan - The landed plan account, decoded.
 * @param owner - The wallet the replacement's plan was created for, as the row or the run names it.
 * @returns The destination.
 * @throws AppError CONFLICT under the cron when the plan's owner is not `owner`, or the plan does
 *   not name exactly one destination.
 */
export function replacementFinalDestination(
  starts: ClaimedUpdateStarts,
  plan: subscriptionsProgram.Plan,
  owner: Address
): Address {
  if (starts.allowed) {
    return assertValidAddress(starts.destinationAddress, "destinationAddress");
  }
  if (plan.owner !== owner) {
    throw conflict("Recurring payment replacement plan on chain belongs to another wallet");
  }
  const [destinationAddress, ...otherDestinations] = plan.data.destinations.filter(
    (destination) => destination !== subscriptionsProgram.ZERO_ADDRESS
  );
  if (destinationAddress === undefined || otherDestinations.length > 0) {
    throw conflict("Recurring payment replacement plan on chain does not name one destination");
  }
  return destinationAddress;
}

/** What a replacement's steps leave for its old cancel and finalize. */
export interface SettledReplacementSteps {
  oldPlanPda: Address;
  oldSubscriptionPda: Address;
  oldSubscription: PaymentSubscriptionRow;
  requestedNextDue: string | null;
  plan: PaymentSubscriptionPlanRow;
  planPda: Address;
  planCreatedAt: string;
  /** The destination the replacement finalizes on (`replacementFinalDestination`). */
  destinationAddress: Address;
  /** Null when the plan's resend was refused as already done. */
  planCreationSignature: Signature | null;
  subscription: PaymentSubscriptionRow;
  subscriptionPda: Address;
  subscriptionAuthorityAddress: Address;
  /** Null when the authorization landed with no signature this attempt holds. */
  authorizationSignature: Signature | null;
}

/**
 * A replacement's new mandate as its landed authorization leaves it, read back from the schedule
 * and the attempt, for the old cancel. The new delegation on chain proves the plan and setup
 * landed and the attempt recorded the new plan and subscription before the authorization, so no
 * step is read or sent: a setup whose token approval was revoked since can never hold the update
 * in flight. One plan account read supplies the plan's creation time, which nothing records
 * before finalize. The signatures are the attempt's, null when it holds none (the trace gap ADR
 * 0009 accepts).
 *
 * @param input - The run's repositories, RPC, tenant, schedule and attempt.
 * @param input.recurringRepo - The recurring payments repository.
 * @param input.subscriptionsRepo - The subscriptions repository.
 * @param input.rpc - The cluster RPC.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPaymentId - The schedule.
 * @param input.attemptId - The run's attempt.
 * @param input.starts - Whether the run may send new steps, which decides where the destination
 *   it finalizes on comes from (`replacementFinalDestination`).
 * @returns The attempt as re-read, and the new mandate's settled steps.
 * @throws AppError CONFLICT when the schedule is no longer `updating` or the attempt is no longer
 *   this run's in-flight attempt.
 * @throws AppError INTERNAL_ERROR when the attempt lacks the new plan or subscription it recorded
 *   before the authorization, their rows or addresses are missing, or the plan is not on chain.
 */
export async function readLandedReplacement(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  subscriptionsRepo: PaymentSubscriptionsRepository;
  rpc: SolanaRpc;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attemptId: string;
  starts: ClaimedUpdateStarts;
}): Promise<{
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  steps: Omit<
    SettledReplacementSteps,
    "oldPlanPda" | "oldSubscriptionPda" | "oldSubscription" | "requestedNextDue"
  >;
}> {
  const tenant = { organizationId: input.organizationId, projectId: input.projectId };
  const [schedule, attempt] = await Promise.all([
    input.recurringRepo.getRecurringPaymentById({
      ...tenant,
      recurringPaymentId: input.recurringPaymentId,
    }),
    input.recurringRepo.getLatestUpdateAttempt({
      ...tenant,
      recurringPaymentId: input.recurringPaymentId,
      statuses: IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
    }),
  ]);
  if (
    schedule === null ||
    !isUpdatingRecurringPaymentStatus(schedule.status) ||
    attempt === null ||
    attempt.id !== input.attemptId
  ) {
    throw conflict("Recurring payment update changed concurrently");
  }
  if (attempt.new_plan_id === null || attempt.new_subscription_id === null) {
    throw internalError("Recurring payment replacement landed without its recorded plan");
  }
  const [plan, subscription] = await Promise.all([
    input.subscriptionsRepo.getPlanById({ ...tenant, planId: attempt.new_plan_id }),
    input.subscriptionsRepo.getSubscriptionById({
      ...tenant,
      subscriptionId: attempt.new_subscription_id,
    }),
  ]);
  if (
    plan === null ||
    plan.plan_pda === null ||
    subscription === null ||
    subscription.subscription_pda === null ||
    subscription.subscription_authority_address === null
  ) {
    throw internalError("Recurring payment replacement plan or subscription was not recorded");
  }
  const planPda = assertValidAddress(plan.plan_pda, "planPda");
  const onChainPlan = await subscriptionsProgram.fetchMaybePlan(input.rpc, planPda, {
    commitment: "confirmed",
  });
  if (!onChainPlan.exists) {
    throw internalError("Recurring payment replacement plan was not found on-chain");
  }
  return {
    attempt,
    steps: {
      plan,
      planPda,
      planCreatedAt: onChainPlan.data.data.terms.createdAt.toString(),
      destinationAddress: replacementFinalDestination(
        input.starts,
        onChainPlan.data,
        assertValidAddress(plan.owner_address, "ownerAddress")
      ),
      planCreationSignature: parseNullableStoredSignature(attempt.plan_creation_signature),
      subscription,
      subscriptionPda: assertValidAddress(subscription.subscription_pda, "subscriptionPda"),
      subscriptionAuthorityAddress: assertValidAddress(
        subscription.subscription_authority_address,
        "subscriptionAuthorityAddress"
      ),
      authorizationSignature: parseNullableStoredSignature(attempt.authorization_signature),
    },
  };
}

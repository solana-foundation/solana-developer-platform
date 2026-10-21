import { resolveRecurringPaymentCollectionSchedule } from "@sdp/payments/recurring-payment-lifecycle";
import { createClusterRpc } from "@sdp/rpc/factory";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { RECURRING_PAYMENT_UPDATE_TRANSITION } from "@sdp/types/payments";
import type { Address, MaybeEncodedAccount, Signature } from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { getDb } from "@/db/client";
import type {
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentUpdateAttemptRow,
} from "@/db/repositories/payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import type {
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
} from "@/db/repositories/payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
} from "@/db/repositories/repository-factory";
import { badRequest, conflict, notFound, transactionFailed } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { readMintFacts } from "@/services/mint-facts";
import { parseU64String } from "@/services/payment-operation.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { SponsoredSendRefusedError } from "@/services/sponsorship-submission";
import type { Env } from "@/types/env";
import {
  delegationCanceledEffect,
  delegationCreatedEffect,
  insideRecurringPaymentStepPhase,
  parseNullableStoredSignature,
  planCreatedEffect,
  type RecurringPaymentSourceWallet,
  type RecurringPaymentStepLogContext,
  type RecurringPaymentStepPhase,
  ResumedStepUnsettledError,
  readSavedRecurringPaymentStep,
  requireUpdatedAttempt,
  requireUpdatedPlan,
  requireUpdatedSubscription,
  sendRecurringPaymentStep,
} from "./shared";
import { SUBSCRIPTION_AUTHORITY_SETUP_FLOWS } from "./subscription-authority";
import {
  recordAnsweredUpdate,
  recordRecurringPaymentUpdateEvent,
  updateStepSigner,
} from "./update-attempt";
import {
  checkReplacementUnwind,
  clearDroppedOldCancel,
  getOrCreateReplacementPlan,
  getOrCreateReplacementSubscription,
  latestSavedReplacementStep,
  readLandedReplacement,
  readSavedOldCancel,
  readUnsentPlanCreationForCron,
  replacementFinalDestination,
  replacementPlanCreationDestination,
  type SettledReplacementSteps,
  sendReplacementAuthorization,
  sendReplacementPlanCreation,
} from "./update-replacement-steps";
import type {
  ClaimedUpdateStarts,
  RecurringPaymentUpdateIdempotency,
  RecurringPaymentUpdateTerms,
} from "./update-request";

function replacementNextCollectionDueAt(input: {
  requested: string | null | undefined;
  periodStartAt: string;
  periodHours: number;
  clampToMinimum: boolean;
}): string {
  const resolution = resolveRecurringPaymentCollectionSchedule({
    request:
      input.requested === undefined || input.requested === null
        ? { kind: "next_period" }
        : { kind: "requested", dueAt: input.requested, clampToMinimum: input.clampToMinimum },
    periodStartAt: input.periodStartAt,
    periodHours: input.periodHours,
  });
  if (resolution.kind === "too_early") {
    throw badRequest(
      "nextCollectionDueAt cannot be earlier than the replacement subscription period"
    );
  }

  return resolution.nextCollectionDueAt;
}

async function finalizeReplacementUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  oldSubscription: PaymentSubscriptionRow;
  plan: PaymentSubscriptionPlanRow;
  subscription: PaymentSubscriptionRow;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: RecurringPaymentUpdateTerms;
  planPda: Address;
  planCreatedAt: string;
  /** The destination the replacement finalizes on (`replacementFinalDestination`). */
  destinationAddress: Address;
  /** Each signature is null when an earlier run's send landed before it was saved. */
  planCreationSignature: Signature | null;
  subscriptionPda: Address;
  subscriptionAuthorityAddress: Address;
  authorizationSignature: Signature | null;
  oldCancelSignature: Signature | null;
  currentPeriodStartAt: string;
  nextCollectionDueAt: string;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
}): Promise<PaymentRecurringPaymentRow> {
  const finalizedAt = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    requireUpdatedSubscription(
      await subscriptionsRepo.updateSubscription({
        subscriptionId: input.oldSubscription.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "canceled",
        cancelAt: finalizedAt,
        canceledAt: finalizedAt,
        updatedAt: finalizedAt,
      })
    );
    if (input.claimed.plan_id) {
      requireUpdatedPlan(
        await subscriptionsRepo.updatePlan({
          planId: input.claimed.plan_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          status: "archived",
          updatedAt: finalizedAt,
        })
      );
    }
    requireUpdatedPlan(
      await subscriptionsRepo.updatePlan({
        planId: input.plan.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planPda: input.planPda,
        status: "active",
        updatedAt: finalizedAt,
      })
    );
    requireUpdatedSubscription(
      await subscriptionsRepo.updateSubscription({
        subscriptionId: input.subscription.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        subscriptionPda: input.subscriptionPda,
        subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
        authorizationSignature: input.authorizationSignature,
        status: "active",
        currentPeriodStartAt: input.currentPeriodStartAt,
        nextCollectionDueAt: input.nextCollectionDueAt,
        updatedAt: finalizedAt,
      })
    );

    const updated = await recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceCustodyWalletId: input.resolved.sourceWallet.id,
      sourceWalletId: input.resolved.sourceWallet.walletId,
      sourceAddress: input.resolved.sourceWallet.publicKey,
      counterpartyId: input.resolved.counterpartyId,
      counterpartyAccountId: input.resolved.counterpartyAccountId,
      destinationAddress: input.destinationAddress,
      destinationTokenAccount: null,
      token: input.resolved.token,
      amount: input.resolved.amount,
      periodHours: input.resolved.periodHours,
      firstCollectionAt: null,
      nextCollectionDueAt: input.nextCollectionDueAt,
      planId: input.plan.id,
      subscriptionId: input.subscription.id,
      planPda: input.planPda,
      planCreatedAt: input.planCreatedAt,
      planCreationSignature: input.planCreationSignature,
      subscriptionPda: input.subscriptionPda,
      subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
      authorizationSignature: input.authorizationSignature,
      status: RECURRING_PAYMENT_UPDATE_TRANSITION.claimableStatus,
      metadataUri: input.resolved.metadataUri,
      expectedStatus: RECURRING_PAYMENT_UPDATE_TRANSITION.processingStatus,
      expectedUpdatedAt: input.claimed.updated_at,
      updatedAt: finalizedAt,
    });
    if (updated === null) {
      throw conflict("Recurring payment update changed concurrently");
    }

    requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: input.attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "confirmed",
        stage: "finalize",
        oldCancelSignature: input.oldCancelSignature,
        error: null,
        updatedAt: finalizedAt,
      })
    );
    const auditChangedFields = input.resolved.changedFields.map(String);
    const auditBeforeValues = { ...input.resolved.beforeValues };
    const auditAfterValues = { ...input.resolved.afterValues };
    if (
      input.claimed.first_collection_at !== null &&
      !auditChangedFields.includes("firstCollectionAt")
    ) {
      auditChangedFields.push("firstCollectionAt");
      auditBeforeValues.firstCollectionAt = input.claimed.first_collection_at;
      auditAfterValues.firstCollectionAt = null;
    }
    if (
      input.claimed.next_collection_due_at !== input.nextCollectionDueAt &&
      !auditChangedFields.includes("nextCollectionDueAt")
    ) {
      auditChangedFields.push("nextCollectionDueAt");
      auditBeforeValues.nextCollectionDueAt = input.claimed.next_collection_due_at;
    }
    if (auditChangedFields.includes("nextCollectionDueAt")) {
      auditAfterValues.nextCollectionDueAt = input.nextCollectionDueAt;
    }
    await recordRecurringPaymentUpdateEvent({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      attemptId: input.attempt.id,
      changedFields: auditChangedFields,
      beforeValues: auditBeforeValues,
      afterValues: auditAfterValues,
      createdBy: input.createdBy,
      createdAt: finalizedAt,
    });

    // A request that finished a stale attempt another key claimed (the attempt
    // keeps that key) is answered under its own key in the same commit, so the
    // update never lands without the record its retry is answered from.
    await recordAnsweredUpdate({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPayment: updated,
      createdBy: input.createdBy,
      idempotency: input.idempotency,
      ranAttemptKey: input.attempt.idempotency_key,
    });
    return updated;
  });
}

export async function runReplacementUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  oldSourceWallet: RecurringPaymentSourceWallet;
  claimed: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: RecurringPaymentUpdateTerms;
  requestedNextCollectionDueAt: string | null | undefined;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
  starts: ClaimedUpdateStarts;
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
  let attempt = input.attempt;
  const savedPlanCreationSignature = parseNullableStoredSignature(attempt.plan_creation_signature);
  const savedAuthorizationSignature = parseNullableStoredSignature(attempt.authorization_signature);
  const savedOldCancelSignature = parseNullableStoredSignature(attempt.old_cancel_signature);
  const replacementPeriodStartAt = attempt.created_at;
  const readsUnsentPlanFromChain =
    !input.starts.allowed &&
    (attempt.authorization_setup_signature !== null ||
      savedAuthorizationSignature !== null ||
      savedOldCancelSignature !== null);
  const phase: RecurringPaymentStepPhase = {
    unreadSavedStep: latestSavedReplacementStep(attempt),
    step: { row: "update_attempt", column: "plan_creation_signature" },
  };
  const stepSigner = updateStepSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.resolved.sourceWallet,
    startsAllowed: input.starts.allowed,
    logContext: { recurring_payment_id: input.claimed.id, attempt_id: attempt.id },
  });

  const resolveOldMandate = async () => {
    if (
      !input.claimed.plan_pda ||
      !input.claimed.subscription_id ||
      !input.claimed.subscription_pda
    ) {
      throw conflict("Recurring payment is missing on-chain subscription records");
    }
    const oldSubscription =
      input.subscription ??
      (await subscriptionsRepo.getSubscriptionById({
        subscriptionId: input.claimed.subscription_id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      }));
    if (!oldSubscription) {
      throw notFound("Subscription");
    }
    return {
      oldPlanPda: assertValidAddress(input.claimed.plan_pda, "planPda"),
      oldSubscriptionPda: assertValidAddress(input.claimed.subscription_pda, "subscriptionPda"),
      oldSubscription,
      requestedNextDue: replacementNextCollectionDueAt({
        requested: input.requestedNextCollectionDueAt,
        periodStartAt: replacementPeriodStartAt,
        periodHours: input.resolved.periodHours,
        clampToMinimum: Boolean(
          savedPlanCreationSignature || savedAuthorizationSignature || savedOldCancelSignature
        ),
      }),
    };
  };

  const replacementSteps = async (): Promise<SettledReplacementSteps> => {
    const { oldPlanPda, oldSubscriptionPda, oldSubscription, requestedNextDue } =
      await resolveOldMandate();
    // An unsent plan creation needs a new send: its signer resolves, or the cron refuses, before
    // any chain read or row write for the replacement.
    if (savedPlanCreationSignature === null && !readsUnsentPlanFromChain) {
      await stepSigner();
    }

    const owner = assertValidAddress(input.resolved.sourceWallet.publicKey, "sourceAddress");
    const mint = assertValidAddress(input.resolved.token, "token");
    const { tokenProgram, decimals } = await readMintFacts(mint);
    const [sourceTokenAccount] = await findAssociatedTokenPda({ owner, tokenProgram, mint });
    const amountBaseUnits = parseDecimalAmount(input.resolved.amount, decimals);
    if (amountBaseUnits <= 0n) {
      throw badRequest("Subscription amount must be greater than zero");
    }

    let plan = await getOrCreateReplacementPlan({
      subscriptionsRepo,
      attempt,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.resolved.sourceWallet,
      resolved: input.resolved,
      planCreationDestination: () =>
        replacementPlanCreationDestination(input.starts, {
          recurring_payment_id: input.claimed.id,
          attempt_id: attempt.id,
        }),
      createdBy: input.createdBy,
    });
    if (attempt.new_plan_id !== plan.id) {
      attempt = requireUpdatedAttempt(
        await recurringRepo.updateUpdateAttempt({
          attemptId: attempt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          newPlanId: plan.id,
          updatedAt: new Date().toISOString(),
        })
      );
    }

    const programPlanId = parseU64String(plan.program_plan_id, "programPlanId");
    const [planPda] = await subscriptionsProgram.findPlanPda({ owner, planId: programPlanId });
    plan = requireUpdatedPlan(
      await subscriptionsRepo.updatePlan({
        planId: plan.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        planPda,
        updatedAt: new Date().toISOString(),
      })
    );

    const planFailureMessage = "Recurring payment replacement plan creation failed on-chain";
    const planSlot = { row: "update_attempt", column: "plan_creation_signature" } as const;
    const planLogContext: RecurringPaymentStepLogContext = {
      recurring_payment_id: attempt.recurring_payment_id,
      attempt_id: attempt.id,
      step: "create_plan",
    };
    // A signature saved in a step's slot means an earlier run reached its send (HOO-2044): the
    // chain settles whether it landed before anything is sent again. A step with no saved
    // signature never left, and reads nothing extra, except under the cron when a later step is
    // saved (`readUnsentPlanCreationForCron`).
    let landedPlanAccounts: readonly MaybeEncodedAccount[] | null = null;
    if (savedPlanCreationSignature !== null) {
      landedPlanAccounts = await readSavedRecurringPaymentStep({
        phase,
        slot: planSlot,
        signature: savedPlanCreationSignature,
        lastValidBlockHeight: attempt.last_valid_block_height,
        effect: planCreatedEffect(planPda),
        failureMessage: planFailureMessage,
        logContext: planLogContext,
      });
    } else if (readsUnsentPlanFromChain) {
      landedPlanAccounts = await readUnsentPlanCreationForCron({
        planPda,
        slot: planSlot,
        logContext: planLogContext,
      });
    }
    let planCreationSignature = savedPlanCreationSignature;
    let onChainPlan =
      landedPlanAccounts === null ? null : subscriptionsProgram.decodePlan(landedPlanAccounts[0]);
    if (!onChainPlan) {
      const created = await sendReplacementPlanCreation({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringRepo,
        attempt,
        sourceWallet: input.resolved.sourceWallet,
        sourceSigner: await stepSigner(),
        resolved: input.resolved,
        owner,
        destination: replacementPlanCreationDestination(input.starts, planLogContext),
        mint,
        tokenProgram,
        amountBaseUnits,
        programPlanId,
        planPda,
        slot: planSlot,
        failureMessage: planFailureMessage,
        logContext: planLogContext,
      });
      attempt = created.attempt;
      planCreationSignature = created.signature;
      onChainPlan = created.onChainPlan;
    }
    if (!onChainPlan.exists) {
      throw transactionFailed("Subscription plan was not found on-chain");
    }
    const planCreatedAt = onChainPlan.data.data.terms.createdAt.toString();
    const destinationAddress = replacementFinalDestination(input.starts, onChainPlan.data, owner);
    phase.step = { row: "update_attempt", column: "authorization_setup_signature" };

    let subscription = await getOrCreateReplacementSubscription({
      subscriptionsRepo,
      attempt,
      organizationId: input.organizationId,
      projectId: input.projectId,
      planId: plan.id,
      resolved: input.resolved,
      createdBy: input.createdBy,
    });
    if (attempt.new_subscription_id !== subscription.id) {
      attempt = requireUpdatedAttempt(
        await recurringRepo.updateUpdateAttempt({
          attemptId: attempt.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          newSubscriptionId: subscription.id,
          updatedAt: new Date().toISOString(),
        })
      );
    }

    const [subscriptionAuthorityAddress] = await subscriptionsProgram.findSubscriptionAuthorityPda({
      tokenMint: mint,
      user: owner,
    });
    const [subscriptionPda] = await subscriptionsProgram.findSubscriptionDelegationPda({
      planPda,
      subscriber: owner,
    });
    subscription = requireUpdatedSubscription(
      await subscriptionsRepo.updateSubscription({
        subscriptionId: subscription.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        subscriberTokenAccount: sourceTokenAccount,
        subscriptionPda,
        subscriptionAuthorityAddress,
        updatedAt: new Date().toISOString(),
      })
    );

    const { subscribeFailureMessage: authorizeFailureMessage, subscribeSlot: authorizeSlot } =
      SUBSCRIPTION_AUTHORITY_SETUP_FLOWS.update;
    const authorizeLogContext: RecurringPaymentStepLogContext = {
      recurring_payment_id: attempt.recurring_payment_id,
      attempt_id: attempt.id,
      step: "authorize_subscription",
    };
    if (savedAuthorizationSignature !== null) {
      phase.step = authorizeSlot;
      await readSavedRecurringPaymentStep({
        phase,
        slot: authorizeSlot,
        signature: savedAuthorizationSignature,
        lastValidBlockHeight: attempt.last_valid_block_height,
        effect: delegationCreatedEffect(subscriptionPda),
        failureMessage: authorizeFailureMessage,
        logContext: authorizeLogContext,
      });
    }
    let authorizationSignature = savedAuthorizationSignature;
    if (savedAuthorizationSignature === null) {
      const authorized = await sendReplacementAuthorization({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringRepo,
        attempt,
        phase,
        sourceWallet: input.resolved.sourceWallet,
        stepSigner,
        sourceTokenAccount,
        subscriptionAuthorityAddress,
        subscriptionPda,
        owner,
        mint,
        tokenProgram,
        amountBaseUnits,
        planCreatedAt,
        periodHours: input.resolved.periodHours,
        programPlanId,
      });
      attempt = authorized.attempt;
      authorizationSignature = authorized.signature;
    }

    return {
      oldPlanPda,
      oldSubscriptionPda,
      oldSubscription,
      requestedNextDue,
      plan,
      planPda,
      planCreatedAt,
      destinationAddress,
      planCreationSignature,
      subscription,
      subscriptionPda,
      subscriptionAuthorityAddress,
      authorizationSignature,
    };
  };
  const replacement = await insideRecurringPaymentStepPhase(phase, replacementSteps, {
    finalStep: SUBSCRIPTION_AUTHORITY_SETUP_FLOWS.update.subscribeSlot,
    check: (cause) =>
      checkReplacementUnwind({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        attempt,
        cause,
      }),
    continueFromLanded: async () => {
      const landed = await readLandedReplacement({
        recurringRepo,
        subscriptionsRepo,
        rpc,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.claimed.id,
        attemptId: attempt.id,
        starts: input.starts,
      });
      attempt = landed.attempt;
      return { ...(await resolveOldMandate()), ...landed.steps };
    },
  });

  const cancelOldLogContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: attempt.recurring_payment_id,
    attempt_id: attempt.id,
    step: "cancel_old_subscription",
  };
  const oldCanceledOnChain =
    savedOldCancelSignature !== null &&
    (await readSavedOldCancel({
      env: input.env,
      attempt,
      signature: savedOldCancelSignature,
      oldSubscriptionPda: replacement.oldSubscriptionPda,
      logContext: cancelOldLogContext,
    }));
  let oldCancelSignature = oldCanceledOnChain ? savedOldCancelSignature : null;
  if (!oldCanceledOnChain) {
    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: "cancel_old_subscription",
        updatedAt: new Date().toISOString(),
      })
    );
    try {
      const oldSourceSigner = await createOrgSignerForCustodyWallet(
        input.env,
        input.organizationId,
        input.projectId,
        input.oldSourceWallet.id,
        "recurring.update_cancel_old"
      );
      if (oldSourceSigner.address !== input.oldSourceWallet.publicKey) {
        throw badRequest("Resolved signing wallet does not match source wallet");
      }
      const cancelInstruction =
        await subscriptionsProgram.getCancelSubscriptionOverlayInstructionAsync({
          planPda: replacement.oldPlanPda,
          subscriber: oldSourceSigner,
          subscriptionPda: replacement.oldSubscriptionPda,
        });
      const settledCancel = await sendRecurringPaymentStep({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        recurringPaymentId: input.claimed.id,
        attemptId: attempt.id,
        movement: "recurring.update_cancel_old",
        sourceWallet: input.oldSourceWallet,
        sourceSigner: oldSourceSigner,
        instructions: [cancelInstruction],
        slot: { row: "update_attempt", column: "old_cancel_signature" },
        effect: delegationCanceledEffect(replacement.oldSubscriptionPda),
        alreadyDone: {
          code: subscriptionsProgram.SUBSCRIPTIONS_ERROR__SUBSCRIPTION_ALREADY_CANCELLED,
          notLanded: "pending",
        },
        onFailure: {
          outcome: "stay_in_flight",
          onDropped: (signature) =>
            clearDroppedOldCancel({
              env: input.env,
              organizationId: input.organizationId,
              projectId: input.projectId,
              recurringPaymentId: input.claimed.id,
              attemptId: attempt.id,
              signature,
              oldSubscriptionPda: replacement.oldSubscriptionPda,
              logContext: cancelOldLogContext,
            }),
        },
        failureMessage: "Recurring payment old subscription cancellation failed on-chain",
        logContext: cancelOldLogContext,
      });
      oldCancelSignature = settledCancel.signature;
    } catch (error) {
      if (!(error instanceof Error) || error instanceof ResumedStepUnsettledError) throw error;
      // The new mandate is live, so the old one's cancel never unwinds: the attempt stays
      // `updating` and the next run sends it again.
      logEvent("error", {
        event: "sdp_api_recurring_payment_old_cancel_failed",
        ...cancelOldLogContext,
        old_subscription_pda: replacement.oldSubscriptionPda,
        refused_signature: error instanceof SponsoredSendRefusedError ? error.signature : null,
        ...describeError(error),
      });
      throw error;
    }
  }

  const finalizedAt = new Date().toISOString();
  const safeNextDue = replacementNextCollectionDueAt({
    requested: replacement.requestedNextDue,
    periodStartAt: finalizedAt,
    periodHours: input.resolved.periodHours,
    clampToMinimum: true,
  });

  return finalizeReplacementUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    claimed: input.claimed,
    oldSubscription: replacement.oldSubscription,
    plan: replacement.plan,
    subscription: replacement.subscription,
    attempt,
    resolved: input.resolved,
    planPda: replacement.planPda,
    planCreatedAt: replacement.planCreatedAt,
    destinationAddress: replacement.destinationAddress,
    planCreationSignature: replacement.planCreationSignature,
    subscriptionPda: replacement.subscriptionPda,
    subscriptionAuthorityAddress: replacement.subscriptionAuthorityAddress,
    authorizationSignature: replacement.authorizationSignature,
    oldCancelSignature,
    currentPeriodStartAt: finalizedAt,
    nextCollectionDueAt: safeNextDue,
    createdBy: input.createdBy,
    idempotency: input.idempotency,
  });
}

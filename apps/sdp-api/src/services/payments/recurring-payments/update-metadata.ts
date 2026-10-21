import { resolveRecurringPaymentCollectionSchedule } from "@sdp/payments/recurring-payment-lifecycle";
import { createClusterRpc } from "@sdp/rpc/factory";
import { assertValidAddress } from "@sdp/solana/address";
import { RECURRING_PAYMENT_UPDATE_TRANSITION } from "@sdp/types/payments";
import * as subscriptionsProgram from "@solana/subscriptions";
import { getDb } from "@/db/client";
import type {
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentUpdateAttemptRow,
} from "@/db/repositories/payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import type { PaymentSubscriptionRow } from "@/db/repositories/payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import { createPaymentRecurringPaymentsRepository } from "@/db/repositories/repository-factory";
import { badRequest, conflict, internalError, transactionFailed } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import type { Env } from "@/types/env";
import {
  insideRecurringPaymentStepPhase,
  parseNullableStoredSignature,
  planMetadataUpdatedEffect,
  type RecurringPaymentPlanMetadataPreImage,
  type RecurringPaymentSourceWallet,
  type RecurringPaymentStepLogContext,
  type RecurringPaymentStepPhase,
  readSavedRecurringPaymentStep,
  requireUpdatedAttempt,
  requireUpdatedPlan,
  requireUpdatedSubscription,
  resolveRecurringPaymentSponsor,
  sendRecurringPaymentStep,
  subscriptionProgramMetadataUri,
} from "./shared";
import {
  recordAnsweredUpdate,
  recordRecurringPaymentUpdateEvent,
  updateStepSigner,
} from "./update-attempt";
import type {
  ClaimedUpdateStarts,
  RecurringPaymentUpdateIdempotency,
  RecurringPaymentUpdateTerms,
} from "./update-request";

function parsePlanStatus(status: subscriptionsProgram.PlanStatus): subscriptionsProgram.PlanStatus {
  switch (status) {
    case subscriptionsProgram.PlanStatus.Sunset:
    case subscriptionsProgram.PlanStatus.Active:
      return status;
    default: {
      const unsupported: never = status;
      throw internalError(`Unsupported subscription plan status: ${unsupported}`);
    }
  }
}

function activeNextCollectionDueAt(input: {
  requested: string | null | undefined;
  recurringPayment: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  onChainSubscription?: Awaited<
    ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>
  > | null;
  clampToMinimum: boolean;
}): string | null | undefined {
  if (input.requested === undefined) {
    return undefined;
  }

  const periodHours = input.recurringPayment.period_hours;
  const onChainStartTs =
    input.onChainSubscription?.exists === true
      ? Number(input.onChainSubscription.data.currentPeriodStartTs)
      : NaN;
  const currentPeriodStartAt = Number.isFinite(onChainStartTs)
    ? new Date(onChainStartTs * 1000).toISOString()
    : (input.subscription?.current_period_start_at ??
      input.recurringPayment.next_collection_due_at);
  if (!currentPeriodStartAt) {
    throw conflict("Recurring payment is missing active subscription timing");
  }

  const resolution = resolveRecurringPaymentCollectionSchedule({
    request:
      input.requested === null
        ? { kind: "next_period" }
        : { kind: "requested", dueAt: input.requested, clampToMinimum: input.clampToMinimum },
    periodStartAt: currentPeriodStartAt,
    periodHours,
  });
  if (resolution.kind === "too_early") {
    throw badRequest("nextCollectionDueAt cannot be earlier than the next eligible collection");
  }

  return resolution.nextCollectionDueAt;
}

async function finalizeMetadataScheduleUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  claimed: PaymentRecurringPaymentRow;
  subscription: PaymentSubscriptionRow | null;
  attempt: PaymentRecurringPaymentUpdateAttemptRow;
  resolved: RecurringPaymentUpdateTerms;
  nextCollectionDueAt: string | null | undefined;
  createdBy: string | null;
  idempotency: RecurringPaymentUpdateIdempotency | null;
}): Promise<PaymentRecurringPaymentRow> {
  const finalizedAt = new Date().toISOString();
  return getDb(input.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(tx);

    if (input.claimed.plan_id && input.resolved.metadataUri !== input.claimed.metadata_uri) {
      requireUpdatedPlan(
        await subscriptionsRepo.updatePlan({
          planId: input.claimed.plan_id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          metadataUri: input.resolved.metadataUri,
          updatedAt: finalizedAt,
        })
      );
    }
    if (input.subscription && input.nextCollectionDueAt !== undefined) {
      requireUpdatedSubscription(
        await subscriptionsRepo.updateSubscription({
          subscriptionId: input.subscription.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          nextCollectionDueAt: input.nextCollectionDueAt,
          expectedStatus: "active",
          updatedAt: finalizedAt,
        })
      );
    }

    const updated = await recurringRepo.updateRecurringPayment({
      recurringPaymentId: input.claimed.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: RECURRING_PAYMENT_UPDATE_TRANSITION.claimableStatus,
      metadataUri: input.resolved.metadataUri,
      nextCollectionDueAt: input.nextCollectionDueAt,
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
        error: null,
        updatedAt: finalizedAt,
      })
    );
    const auditAfterValues =
      input.nextCollectionDueAt !== undefined &&
      input.resolved.changedFields.includes("nextCollectionDueAt")
        ? { ...input.resolved.afterValues, nextCollectionDueAt: input.nextCollectionDueAt }
        : input.resolved.afterValues;
    await recordRecurringPaymentUpdateEvent({
      recurringRepo,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      attemptId: input.attempt.id,
      changedFields: input.resolved.changedFields.map(String),
      beforeValues: input.resolved.beforeValues,
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

/**
 * The plan's update-guarded fields as the claimed schedule recorded them: what every plan update
 * send expects and every read of it compares against.
 *
 * @param claimed - The claimed active schedule.
 * @returns Its plan's `createdAt` and metadata URI as the program stores them.
 * @throws AppError INTERNAL_ERROR when the schedule has no recorded plan creation time.
 */
function planMetadataPreImage(
  claimed: PaymentRecurringPaymentRow
): RecurringPaymentPlanMetadataPreImage {
  if (claimed.plan_created_at === null) {
    throw internalError("Recurring payment is missing its on-chain plan creation time");
  }
  return {
    createdAt: claimed.plan_created_at,
    metadataUri: subscriptionProgramMetadataUri(claimed.metadata_uri),
  };
}

export async function runMetadataScheduleUpdate(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
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
  const rpc = createClusterRpc();
  let attempt = input.attempt;
  const planUpdateSignature = parseNullableStoredSignature(attempt.plan_update_signature);
  const phase: RecurringPaymentStepPhase = {
    unreadSavedStep: planUpdateSignature === null ? null : "plan_update_signature",
    step: { row: "update_attempt", column: "plan_update_signature" },
  };
  const stepSigner = updateStepSigner({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceWallet: input.sourceWallet,
    startsAllowed: input.starts.allowed,
    logContext: { recurring_payment_id: input.claimed.id, attempt_id: attempt.id },
  });

  const metadataSteps = async () => {
    let onChainSubscription: Awaited<
      ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>
    > | null = null;
    if (input.requestedNextCollectionDueAt !== undefined && input.claimed.subscription_pda) {
      onChainSubscription = await subscriptionsProgram.fetchMaybeSubscriptionDelegation(
        rpc,
        assertValidAddress(input.claimed.subscription_pda, "subscriptionPda"),
        { commitment: "confirmed" }
      );
    }
    const resolvedNextDueAt = activeNextCollectionDueAt({
      requested: input.requestedNextCollectionDueAt,
      recurringPayment: input.claimed,
      subscription: input.subscription,
      onChainSubscription,
      clampToMinimum: planUpdateSignature !== null,
    });

    if (input.resolved.metadataUri === input.claimed.metadata_uri) {
      return resolvedNextDueAt;
    }
    if (!input.claimed.plan_pda) {
      throw conflict("Recurring payment is missing on-chain plan records");
    }

    const planPda = assertValidAddress(input.claimed.plan_pda, "planPda");
    const failureMessage = "Recurring payment update failed on-chain";
    const slot = { row: "update_attempt", column: "plan_update_signature" } as const;
    const targetMetadataUri = subscriptionProgramMetadataUri(input.resolved.metadataUri);
    const logContext: RecurringPaymentStepLogContext = {
      recurring_payment_id: input.claimed.id,
      attempt_id: attempt.id,
      step: "update_plan",
    };
    // Every send and read of this step works from the pre-image the schedule recorded, fresh or
    // resumed: the send expects it, so the program refuses (522) a plan changed outside this
    // attempt instead of overwriting it, and the effect compares the plan against it.
    const preImage = planMetadataPreImage(input.claimed);
    const effect = planMetadataUpdatedEffect({
      planPda,
      preImage,
      targetMetadataUri,
      logContext,
    });
    // A signature saved in the step's slot means an earlier run reached the send (HOO-2044): the
    // plan's metadata settles whether it landed.
    if (planUpdateSignature !== null) {
      await readSavedRecurringPaymentStep({
        phase,
        slot,
        signature: planUpdateSignature,
        lastValidBlockHeight: attempt.last_valid_block_height,
        effect,
        failureMessage,
        logContext,
      });
      return resolvedNextDueAt;
    }

    const sourceSigner = await stepSigner();
    const onChainPlan = await subscriptionsProgram.fetchMaybePlan(rpc, planPda, {
      commitment: "confirmed",
    });
    if (!onChainPlan.exists) {
      throw transactionFailed("Subscription plan was not found on-chain");
    }

    attempt = requireUpdatedAttempt(
      await recurringRepo.updateUpdateAttempt({
        attemptId: attempt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        stage: "update_plan",
        updatedAt: new Date().toISOString(),
      })
    );
    const instruction = await subscriptionsProgram.getUpdatePlanOverlayInstruction({
      endTs: onChainPlan.data.data.endTs,
      expectedCreatedAt: BigInt(preImage.createdAt),
      expectedEndTs: onChainPlan.data.data.endTs,
      expectedMetadataUri: preImage.metadataUri,
      expectedPullers: onChainPlan.data.data.pullers,
      metadataUri: targetMetadataUri,
      owner: sourceSigner,
      planPda,
      pullers: onChainPlan.data.data.pullers,
      status: parsePlanStatus(onChainPlan.data.status),
    });
    await sendRecurringPaymentStep({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId: input.claimed.id,
      attemptId: attempt.id,
      movement: "recurring.update",
      sourceWallet: input.sourceWallet,
      sourceSigner,
      sponsor: await resolveRecurringPaymentSponsor({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceWallet: input.sourceWallet,
      }),
      instructions: [instruction],
      slot,
      effect,
      alreadyDone: {
        code: subscriptionsProgram.SUBSCRIPTIONS_ERROR__STALE_PLAN_APPROVAL,
        notLanded: "failed",
      },
      onFailure: { outcome: "unwind" },
      failureMessage,
      logContext,
    });
    return resolvedNextDueAt;
  };
  const nextDueAt = await insideRecurringPaymentStepPhase(phase, metadataSteps, null);

  return finalizeMetadataScheduleUpdate({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    claimed: input.claimed,
    subscription: input.subscription,
    attempt,
    resolved: input.resolved,
    nextCollectionDueAt: nextDueAt,
    createdBy: input.createdBy,
    idempotency: input.idempotency,
  });
}

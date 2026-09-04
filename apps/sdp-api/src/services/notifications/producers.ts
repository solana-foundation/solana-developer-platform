// One thin notifyX() helper per event, so producer call sites stay one-liners.
//
// Every helper is best-effort and NEVER throws: producers sit on webhook/response/cron
// hot paths where a notification problem must not fail the operation that triggered it
// (mirrors emitTokenOperationCompleted's posture). Context-based helpers start the
// dispatch before touching c.executionCtx (the getter throws on @hono/node-server) and
// hand the promise to waitUntil when one exists.
//
// Audience defaults to admins everywhere: members are reachable via the configurable
// workflow `notify` action, so unconditional producers stay low-noise.
//
// Deliberately NOT wired: token_operation_completed. It fires on every mint/burn/
// freeze/…, so an unconditional notification would be pure spam — issuers who want it
// configure a `notify` workflow rule, which is exactly what that action is for.

import type { Context } from "hono";
import type { KycWalletRow, WorkflowExecutionRow } from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import { humanizeWorkflowKey } from "@/services/workflows/labels";
import type { Env } from "@/types/env";
import { dispatchCounterpartyEmail, dispatchNotification } from "./dispatcher";

type AppContext = Context<{ Bindings: Env }>;

// Keep a fire-and-forget dispatch alive across the response boundary where an
// ExecutionContext exists (Workers); on Node the in-flight promise finishes on its own.
function fireAndForget(c: AppContext, work: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No ExecutionContext — the work is already in flight. Nothing to do.
  }
}

// ── Workflow family ──

// An execution was held for human review (manual review mode or a requires_approval
// action). Awaited by the event bus — dispatchNotification never throws.
export async function notifyApprovalRequested(
  env: Env,
  execution: WorkflowExecutionRow
): Promise<void> {
  const triggerLabel = humanizeWorkflowKey(execution.trigger_type);
  const actionLabel = humanizeWorkflowKey(execution.action_type);
  await dispatchNotification(env, {
    organizationId: execution.organization_id,
    projectId: execution.project_id,
    type: "workflow_approval_requested",
    eventKey: `workflow_approval_requested:${execution.id}`,
    title: "Workflow action awaiting review",
    body: `A ${triggerLabel} event proposed "${actionLabel}" and is waiting for a reviewer.`,
    resourceType: "token",
    resourceId: execution.token_id,
    params: {
      workflowId: execution.workflow_id,
      executionId: execution.id,
      triggerType: execution.trigger_type,
      actionType: execution.action_type,
    },
  });
}

// A reviewer approved or rejected a held execution. The decider is excluded — they
// were there. `decidedBy` can be an API-key id, in which case exclusion no-ops.
export function notifyApprovalDecided(
  c: AppContext,
  input: {
    execution: WorkflowExecutionRow;
    decision: "approved" | "rejected";
    decidedBy: string;
  }
): void {
  const actionLabel = humanizeWorkflowKey(input.execution.action_type);
  fireAndForget(
    c,
    dispatchNotification(c.env, {
      organizationId: input.execution.organization_id,
      projectId: input.execution.project_id,
      type: "workflow_approval_decided",
      // An execution is decided once, so the id alone keys idempotency.
      eventKey: `workflow_approval_decided:${input.execution.id}`,
      title:
        input.decision === "approved" ? "Workflow action approved" : "Workflow action rejected",
      body: `The held "${actionLabel}" action was ${input.decision}.`,
      resourceType: "token",
      resourceId: input.execution.token_id,
      params: {
        decision: input.decision,
        workflowId: input.execution.workflow_id,
        executionId: input.execution.id,
        triggerType: input.execution.trigger_type,
        actionType: input.execution.action_type,
      },
      excludeUserIds: [input.decidedBy],
    })
  );
}

// A run reached terminal failure (engine failure or stale-park). Successes are NOT
// notified — they're the normal case; the workflows tab is their record. Note the
// execution-id key: fail → manual retry → fail again stays one notification (an
// accepted anti-spam trade documented here on purpose).
export async function notifyWorkflowRunFailed(
  env: Env,
  execution: WorkflowExecutionRow,
  reason: string | null
): Promise<void> {
  const triggerLabel = humanizeWorkflowKey(execution.trigger_type);
  const actionLabel = humanizeWorkflowKey(execution.action_type);
  await dispatchNotification(env, {
    organizationId: execution.organization_id,
    projectId: execution.project_id,
    type: "workflow_run_failed",
    eventKey: `workflow_run_failed:${execution.id}`,
    title: "Workflow run failed",
    body: `The ${triggerLabel} → "${actionLabel}" automation failed${reason ? `: ${reason}` : "."}`,
    resourceType: "token",
    resourceId: execution.token_id,
    params: {
      workflowId: execution.workflow_id,
      executionId: execution.id,
      triggerType: execution.trigger_type,
      actionType: execution.action_type,
      reason,
    },
  });
}

// ── Members family ──

export function notifyMemberInvited(
  c: AppContext,
  input: {
    organizationId: string;
    invitationId: string;
    email: string;
    role: string;
    actorUserId?: string | null;
  }
): void {
  fireAndForget(
    c,
    dispatchNotification(c.env, {
      organizationId: input.organizationId,
      type: "member_invited",
      eventKey: `member_invited:${input.invitationId}`,
      title: "Member invited",
      body: `${input.email} was invited to the organization as ${input.role}.`,
      resourceType: "invitation",
      resourceId: input.invitationId,
      params: { email: input.email, role: input.role },
      excludeUserIds: input.actorUserId ? [input.actorUserId] : undefined,
    })
  );
}

// Fired from BOTH acceptance paths (token-link acceptInvitation and the Clerk
// membership webhook) with the same (org, user) key, so a double-fire collapses on
// dedupe. Known edge, accepted: a removed-then-re-invited member won't re-notify —
// the dedupe row persists.
export function notifyMemberJoined(
  c: AppContext,
  input: { organizationId: string; userId: string; email: string | null; role: string | null }
): void {
  fireAndForget(
    c,
    dispatchNotification(c.env, {
      organizationId: input.organizationId,
      type: "member_joined",
      eventKey: `member_joined:${input.organizationId}:${input.userId}`,
      title: "Member joined",
      body: `${input.email ?? "A new member"} joined the organization.`,
      resourceType: "member",
      resourceId: input.userId,
      params: { email: input.email, role: input.role },
      excludeUserIds: [input.userId],
    })
  );
}

export function notifyMemberInviteRevoked(
  c: AppContext,
  input: {
    organizationId: string;
    invitationId: string;
    email: string;
    actorUserId?: string | null;
  }
): void {
  fireAndForget(
    c,
    dispatchNotification(c.env, {
      organizationId: input.organizationId,
      type: "member_invite_revoked",
      eventKey: `member_invite_revoked:${input.invitationId}`,
      title: "Invitation revoked",
      body: `The invitation for ${input.email} was revoked.`,
      resourceType: "invitation",
      resourceId: input.invitationId,
      params: { email: input.email },
      excludeUserIds: input.actorUserId ? [input.actorUserId] : undefined,
    })
  );
}

// The removed member is excluded alongside the actor: their inbox in this org is
// unreachable once the membership row is gone.
//
// Both call sites (API removal and the Clerk webhook sync) are transition-guarded —
// each only calls this when ITS status update actually flipped the row to 'removed' —
// so exactly one fires per removal. That frees the eventKey to carry a timestamp for
// per-occurrence uniqueness: a member who is re-invited and later removed again
// notifies again (unlike a static (org, user) key, which went silent forever).
export function notifyMemberRemoved(
  c: AppContext,
  input: {
    organizationId: string;
    removedUserId: string;
    email: string | null;
    actorUserId?: string | null;
  }
): void {
  const excluded = [input.removedUserId];
  if (input.actorUserId) {
    excluded.push(input.actorUserId);
  }
  fireAndForget(
    c,
    dispatchNotification(c.env, {
      organizationId: input.organizationId,
      type: "member_removed",
      eventKey: `member_removed:${input.organizationId}:${input.removedUserId}:${new Date().toISOString()}`,
      title: "Member removed",
      body: `${input.email ?? "A member"} was removed from the organization.`,
      resourceType: "member",
      resourceId: input.removedUserId,
      params: { email: input.email },
      excludeUserIds: excluded,
    })
  );
}

// ── Payments family ──

function formatAmount(amount?: string | null, currency?: string | null): string {
  if (!amount) return "";
  return currency ? ` of ${amount} ${currency}` : ` of ${amount}`;
}

// Internal admin notification + (when the transfer has a counterparty with a contact
// email) an external settlement receipt to that counterparty. Same shape as
// emitRampSettled and wired at the same call sites — but unlike the emit (rules are
// project-scoped), the admin notification also fires for project-less transfers; only
// the counterparty receipt needs a project (the tenant-scoped lookup pins to it).
export function notifyRampSettled(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string | null;
    direction: "onramp" | "offramp";
    transferId: string;
    provider?: string | null;
    counterpartyId?: string | null;
    amount?: string | null;
    fiatCurrency?: string | null;
    cryptoToken?: string | null;
  }
): void {
  fireAndForget(c, Promise.allSettled(rampSettledDispatches(c.env, input)));
}

// Env-based twin for callers outside a request context (the shared settlement
// applier runs from webhook workers and cron alike). Same dispatches, awaited.
export async function notifyRampSettledFromEnv(
  env: Env,
  input: Parameters<typeof notifyRampSettled>[1]
): Promise<void> {
  await Promise.allSettled(rampSettledDispatches(env, input));
}

function rampSettledDispatches(
  env: Env,
  input: Parameters<typeof notifyRampSettled>[1]
): Promise<unknown>[] {
  const directionLabel = input.direction === "offramp" ? "Off-ramp" : "On-ramp";
  const amountText = formatAmount(input.amount, input.fiatCurrency);
  return [
    dispatchNotification(env, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      type: "payment_settled",
      eventKey: `payment_settled:${input.transferId}`,
      title: "Payment settled",
      body: `${directionLabel} transfer${amountText} settled.`,
      resourceType: "payment_transfer",
      resourceId: input.transferId,
      params: {
        direction: input.direction,
        transferId: input.transferId,
        provider: input.provider ?? null,
        amount: input.amount ?? null,
        fiatCurrency: input.fiatCurrency ?? null,
        cryptoToken: input.cryptoToken ?? null,
      },
    }),
    input.counterpartyId && input.projectId
      ? dispatchCounterpartyEmail(env, {
          organizationId: input.organizationId,
          projectId: input.projectId,
          counterpartyId: input.counterpartyId,
          type: "payment_settled",
          eventKey: `payment_settled:${input.transferId}`,
          title: "Your payment has settled",
          body: `Your ${input.direction === "offramp" ? "payout" : "payment"}${amountText} has settled.`,
        })
      : Promise.resolve(null),
  ];
}

// Env-based (cron). Best-effort; dispatchNotification never throws.
export async function notifyRecurringPaymentFailed(
  env: Env,
  input: {
    organizationId: string;
    projectId: string;
    recurringPaymentId: string;
    attemptId: string;
    error?: string | null;
  }
): Promise<void> {
  await dispatchNotification(env, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    type: "recurring_payment_failed",
    // One notification per failed attempt — each attempt is separately actionable.
    eventKey: `recurring_payment_failed:${input.attemptId}`,
    title: "Recurring payment failed",
    body: `A recurring payment collection attempt failed${input.error ? `: ${input.error}` : "."}`,
    resourceType: "recurring_payment",
    resourceId: input.recurringPaymentId,
    params: {
      recurringPaymentId: input.recurringPaymentId,
      attemptId: input.attemptId,
      error: input.error ?? null,
    },
  });
}

// ── Compliance family ──

// Fired ONCE per wallet status transition — never per enrollment, a multi-asset wallet
// must not multi-notify. The status_changed_at component matches the workflow emitters'
// transition() semantics: a re-verified holder re-fires, a redelivered webhook doesn't.
// Also sends the external outcome receipt to the linked counterparty, when one exists.
export async function notifyKycOutcome(
  env: Env,
  input: { kycWallet: KycWalletRow; status: "verified" | "rejected"; provider?: string | null }
): Promise<void> {
  const type = input.status === "verified" ? "kyc_approved" : "kyc_rejected";
  const eventKey = `${type}:${input.kycWallet.id}:${input.kycWallet.status_changed_at}`;
  const outcomeLabel = input.status === "verified" ? "approved" : "rejected";
  const results = await Promise.allSettled([
    dispatchNotification(env, {
      organizationId: input.kycWallet.organization_id,
      projectId: input.kycWallet.project_id,
      type,
      eventKey,
      title: `Holder verification ${outcomeLabel}`,
      body: `Identity verification for wallet ${input.kycWallet.wallet_address} was ${outcomeLabel}.`,
      resourceType: input.kycWallet.counterparty_id ? "counterparty" : "kyc_wallet",
      resourceId: input.kycWallet.counterparty_id ?? input.kycWallet.id,
      params: {
        wallet: input.kycWallet.wallet_address,
        counterpartyId: input.kycWallet.counterparty_id,
        provider: input.provider ?? input.kycWallet.kyc_provider,
        status: input.status,
      },
    }),
    input.kycWallet.counterparty_id
      ? dispatchCounterpartyEmail(env, {
          organizationId: input.kycWallet.organization_id,
          projectId: input.kycWallet.project_id,
          counterpartyId: input.kycWallet.counterparty_id,
          type,
          // Keyed on the COUNTERPARTY, not the wallet: a provider webhook that verifies
          // a multi-wallet counterparty calls this once per wallet, and the external
          // recipient must get one receipt, not one per wallet. status_changed_at is
          // set by a single UPDATE (now() is transaction-stable), so every wallet in
          // that batch carries the identical timestamp and the claim collapses them —
          // while a genuine later re-transition still re-fires.
          eventKey: `${type}:${input.kycWallet.counterparty_id}:${input.kycWallet.status_changed_at}`,
          title: `Your identity verification was ${outcomeLabel}`,
          body:
            input.status === "verified"
              ? "Your identity verification has been approved."
              : "Your identity verification was rejected. Please contact the organization that requested it for next steps.",
        })
      : Promise.resolve(null),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      getLogger().error(
        {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
        "notifyKycOutcome: dispatch failed"
      );
    }
  }
}

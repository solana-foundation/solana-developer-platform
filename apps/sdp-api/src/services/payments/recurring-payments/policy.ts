import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import type { WalletOperationActor, WalletOperationType } from "@sdp/types";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { enforceWalletOperationPolicy } from "@/services/policy/enforcement.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

export type RecurringPaymentOperationType = Extract<
  WalletOperationType,
  "recurring_payment_create" | "recurring_payment_update" | "recurring_payment_collection"
>;

interface PendingCollectionApprovalRow {
  wallet_operation_id: string;
  policy_evaluation_id: string;
  decision: string;
  reason_code: string;
  reason: string | null;
  requires_approval: boolean;
  approval_request_id: string;
}

/**
 * The pending approval already filed for a collection cycle, if any. A due
 * collection is retried until it settles, so without this lookup every retry
 * would record a fresh operation and file a duplicate approval request for
 * the same recurring payment + due cycle. Matches both a still-pending
 * decision and one already approved but not yet executed, since a cycle whose
 * approval was granted is still in flight and must not spawn a second
 * request. A rejected or cancelled cycle does not match, so a legitimate
 * later retry can still reach a fresh decision.
 *
 * @param input - The tenant and the collection cycle to look up.
 * @returns The pending decision's rows, or null when none is pending.
 */
async function findPendingCollectionApproval(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  collectionDueAt: string;
}): Promise<PendingCollectionApprovalRow | null> {
  return getDb(input.env)
    .prepare(
      `SELECT wo.id AS wallet_operation_id,
              pe.id AS policy_evaluation_id,
              pe.decision,
              pe.reason_code,
              pe.reason,
              pe.requires_approval,
              ar.id AS approval_request_id
         FROM wallet_operations wo
         JOIN approval_requests ar
           ON ar.wallet_operation_id = wo.id
          AND ar.status IN ('pending', 'approved')
         JOIN policy_evaluations pe
           ON pe.approval_request_id = ar.id
        WHERE wo.organization_id = ?
          AND wo.project_id = ?
          AND wo.operation_type = 'recurring_payment_collection'
          AND wo.status IN ('pending_approval', 'executing')
          AND wo.raw_payload->>'recurringPaymentId' = ?
          AND wo.raw_payload->>'collectionDueAt' = ?
        ORDER BY pe.created_at DESC
        LIMIT 1`
    )
    .bind(input.organizationId, input.projectId, input.recurringPaymentId, input.collectionDueAt)
    .first<PendingCollectionApprovalRow>();
}

/**
 * Enforce wallet-operation policy on a recurring-payment operation. Create
 * and update gate the configured transfer shape; collection gates the actual
 * funds movement each cycle. Non-allow decisions throw the route-contract
 * error (403 deny / 202 approval-pending), which a collection run records as
 * the attempt's failure.
 *
 * A collection retry for a cycle whose decision is still outstanding, whether
 * pending or approved-but-unexecuted, rethrows that existing decision instead
 * of filing a duplicate approval request, so each due cycle holds at most one
 * approval across retries.
 *
 * @param input - The operation's tenant, wallet, transfer shape, and initiator.
 * @returns The recorded operation and its evaluation when allowed.
 */
export async function enforceRecurringPaymentPolicy(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  operationType: RecurringPaymentOperationType;
  token: string;
  amount: string;
  destination: string;
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
  rawPayload: Record<string, unknown>;
}): Promise<WalletOperationPolicyEnforcement> {
  const scope = createTenantScope({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  const recurringPaymentId = input.rawPayload.recurringPaymentId;
  const collectionDueAt = input.rawPayload.collectionDueAt;
  if (
    input.operationType === "recurring_payment_collection" &&
    typeof recurringPaymentId === "string" &&
    typeof collectionDueAt === "string"
  ) {
    const pending = await findPendingCollectionApproval({
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      recurringPaymentId,
      collectionDueAt,
    });
    if (pending) {
      throw new AppError("SIGNING_PENDING", "Wallet operation requires policy approval", {
        walletOperationId: pending.wallet_operation_id,
        policyEvaluationId: pending.policy_evaluation_id,
        decision: pending.decision,
        reasonCode: pending.reason_code,
        reason: pending.reason,
        requiresApproval: pending.requires_approval,
        approvalRequestId: pending.approval_request_id,
      });
    }
  }

  return enforceWalletOperationPolicy(input.env, scope, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    custodyWalletId: input.sourceWallet.id,
    walletId: input.sourceWallet.walletId,
    apiKeyId: input.apiKeyId,
    actor: input.actor,
    source: input.apiKeyId === null && input.actor === null ? "system" : "api",
    operationFamily: "payment",
    operationType: input.operationType,
    asset: input.token,
    amount: input.amount,
    destination: input.destination,
    legs: [],
    context: {
      sourceAddress: input.sourceWallet.publicKey,
    },
    providerExtensions: {},
    rawPayload: input.rawPayload,
  });
}

import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import type { WalletOperationActor, WalletOperationType } from "@sdp/types";
import { type DatabaseExecutor, getDb } from "@/db";
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
  custody_wallet_id: string | null;
  policy_evaluation_id: string;
  decision: string;
  reason_code: string;
  reason: string | null;
  requires_approval: boolean;
  approval_request_id: string;
}

/**
 * Finds an unfinished approval for the exact wallet and collection cycle.
 * Collection retries use it to avoid duplicate approvals; source changes use
 * it as a fence. Legacy rows without a custody wallet ID also match so callers
 * can fail closed instead of assigning the approval to a current exact wallet.
 * Rejected or cancelled approvals do not match.
 *
 * @param input - The tenant and the collection cycle to look up.
 * @returns The pending decision's rows, or null when none is pending.
 */
async function findPendingCollectionApproval(input: {
  db: DatabaseExecutor;
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
  recurringPaymentId: string;
  collectionDueAt: string;
}): Promise<PendingCollectionApprovalRow | null> {
  return input.db
    .prepare(
      `SELECT wo.id AS wallet_operation_id,
              wo.custody_wallet_id,
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
           AND (wo.custody_wallet_id = ? OR wo.custody_wallet_id IS NULL)
           AND wo.status IN ('pending_approval', 'executing')
           AND wo.raw_payload->>'recurringPaymentId' = ?
           AND wo.raw_payload->>'collectionDueAt' = ?
        ORDER BY wo.custody_wallet_id NULLS FIRST, pe.created_at DESC
        LIMIT 1`
    )
    .bind(
      input.organizationId,
      input.projectId,
      input.custodyWalletId,
      input.recurringPaymentId,
      input.collectionDueAt
    )
    .first<PendingCollectionApprovalRow>();
}

export async function assertNoPendingRecurringCollectionApproval(input: {
  db: DatabaseExecutor;
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
  recurringPaymentId: string;
  collectionDueAt: string | null;
}): Promise<void> {
  if (!input.collectionDueAt) return;

  const pending = await findPendingCollectionApproval({
    ...input,
    collectionDueAt: input.collectionDueAt,
  });
  if (pending) {
    throw new AppError(
      "CONFLICT",
      "Recurring payment source cannot change while a collection approval is pending",
      {
        walletOperationId: pending.wallet_operation_id,
        policyEvaluationId: pending.policy_evaluation_id,
        approvalRequestId: pending.approval_request_id,
      }
    );
  }
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
      db: getDb(input.env),
      organizationId: input.organizationId,
      projectId: input.projectId,
      custodyWalletId: input.sourceWallet.id,
      recurringPaymentId,
      collectionDueAt,
    });
    if (pending) {
      const details = {
        walletOperationId: pending.wallet_operation_id,
        policyEvaluationId: pending.policy_evaluation_id,
        decision: pending.decision,
        reasonCode: pending.reason_code,
        reason: pending.reason,
        requiresApproval: pending.requires_approval,
        approvalRequestId: pending.approval_request_id,
      };
      if (pending.custody_wallet_id === null) {
        throw new AppError(
          "CONFLICT",
          "Recurring payment collection approval wallet identity is unresolved",
          details
        );
      }
      throw new AppError("SIGNING_PENDING", "Wallet operation requires policy approval", details);
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

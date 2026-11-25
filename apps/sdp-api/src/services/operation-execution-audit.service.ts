import { getDb } from "@/db/client";
import {
  createOperationsRepository,
  type OperationClaim,
  type OperationScope,
  type OperationSignedAttempt,
} from "@/db/repositories/operations.repository";
import type { AppContext } from "@/routes/earn/context";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, type AuditLogEntry, AuditService } from "./audit.service";

function acceptanceEntry(scope: OperationScope, claim: OperationClaim): AuditLogEntry {
  const principal = claim.attempt.principal;
  return {
    organizationId: scope.organizationId,
    userId: principal.kind === "member" ? principal.userId : undefined,
    apiKeyId: principal.kind === "api_key" ? principal.apiKeyId : undefined,
    action: "submit",
    resourceType: "earn_operation",
    resourceId: claim.operation.id,
    metadata: {
      projectId: scope.projectId,
      environment: scope.environment,
      kind: claim.operation.kind,
      actionId: claim.operation.actionId,
      version: claim.operation.version,
      attemptId: claim.attempt.id,
    },
  };
}

/** Repair a lost response without appending another accepted-action outcome. */
async function completeAcceptance(c: AppContext, intent: AuditIntent, claim: OperationClaim) {
  const found = await getDb(c.env).queryOne<{ present: number }>(
    `SELECT 1 AS present FROM audit_logs WHERE organization_id = ?
       AND action = 'submit' AND resource_type = 'earn_operation' AND resource_id = ?
       AND CASE WHEN metadata IS NOT NULL AND pg_input_is_valid(metadata, 'jsonb')
         THEN metadata::jsonb ->> 'auditIntentId' = ? ELSE false END LIMIT 1`,
    [intent.entry.organizationId, claim.operation.id, intent.id]
  );
  if (found !== null) return;
  await new AuditService(getDb(c.env)).completeCritical(c, intent, {
    metadata: {
      executionStage: "accepted",
      // This event describes authorization acceptance, never chain settlement.
      operationStatus: claim.recoveryRequired ? claim.operation.status : "queued",
      sideEffectsPerformedByRequest: false,
      settlementObserved: false,
    },
  });
}

/**
 * Deposit admission is fail closed and atomic with queue acceptance. Exits keep
 * their durable queue request when auditing is unavailable (ADR 0002), matching
 * movement-audit.ts. The operation attempt remains authoritative in either case.
 */
export async function acceptOperationExecution(
  c: AppContext,
  scope: OperationScope,
  claim: OperationClaim,
  signed?: OperationSignedAttempt
): Promise<void> {
  const repository = createOperationsRepository(getDb(c.env));
  const exit = claim.operation.kind === "earn.withdraw";
  if (exit) await repository.requestExecution(scope, claim, signed);
  const entry = acceptanceEntry(scope, claim);
  let linked: AuditIntent | null;
  try {
    linked = await new AuditService(getDb(c.env)).beginCriticalWithin(c, entry, (tx, id) =>
      repository.requestExecutionWithin(tx, scope, claim, id, signed)
    );
  } catch (error) {
    if (!exit) throw error;
    logAuditFailure(scope, claim, error);
    return;
  }
  // Acceptance is durable now. An outcome read/write outage cannot turn the
  // accepted request into an apparent execution refusal.
  try {
    const auditIntentId =
      linked?.id ?? (await repository.getAttempt(scope, claim.operation.id))?.auditIntentId;
    if (auditIntentId !== null && auditIntentId !== undefined)
      await completeAcceptance(c, linked ?? { id: auditIntentId, entry }, claim);
  } catch (error) {
    logAuditFailure(scope, claim, error);
  }
}

function logAuditFailure(scope: OperationScope, claim: OperationClaim, error: unknown) {
  getLogger().error(
    {
      event: "operation_acceptance_audit_failed",
      operationId: claim.operation.id,
      actionId: claim.operation.actionId,
      organizationId: scope.organizationId,
      error,
    },
    "Execution remains queued; its accepted-action audit needs reconciliation"
  );
}

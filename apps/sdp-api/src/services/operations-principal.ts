import { getDb } from "@/db/client";
import { currentDatabaseIdentity } from "@/db/identity";
import type { OperationClaim, OperationScope } from "@/db/repositories/operations.repository";
import { internalError } from "@/lib/errors";
import { moneyPrincipalSchema, runAsMoneyPrincipal } from "@/lib/money-principal";
import type { Env } from "@/types/env";

/**
 * Restore only the authenticated principal of the exact currently leased
 * operation action. No caller-supplied principal or grants are accepted. This
 * entry is reserved for the operation recovery cron; HTTP execution retains
 * its original ambient identity and live custody admission still runs later.
 */
export async function runAsRecordedOperationPrincipal<T>(
  env: Env,
  scope: OperationScope,
  claim: OperationClaim,
  work: () => Promise<T>
): Promise<T> {
  const identity = currentDatabaseIdentity();
  if (identity?.kind !== "system" || identity.component !== "cron:reconcile-operations")
    throw internalError("Recorded operation authority is restricted to its recovery worker");
  const row = await getDb(env).queryOne<{ principal: unknown }>(
    `SELECT attempt.principal FROM operation_attempts attempt
     JOIN operations operation ON operation.id = attempt.operation_id
       AND operation.organization_id = attempt.organization_id
       AND operation.project_id = attempt.project_id AND operation.environment = attempt.environment
     WHERE operation.id = ? AND attempt.id = ? AND operation.organization_id = ?
       AND operation.project_id = ? AND operation.environment = ?
       AND operation.action_id = attempt.action_id AND operation.action_version = attempt.action_version
       AND attempt.action_id = ? AND attempt.action_version = ?
       AND operation.claim_token = ? AND operation.fence = ? AND operation.claim_until > now()`,
    [
      claim.operation.id,
      claim.attempt.id,
      scope.organizationId,
      scope.projectId,
      scope.environment,
      claim.operation.actionId,
      claim.operation.version,
      claim.token,
      claim.fence,
    ]
  );
  if (row === null) throw internalError("Recorded operation action or execution lease changed");
  return runAsMoneyPrincipal(moneyPrincipalSchema.parse(row.principal), work);
}

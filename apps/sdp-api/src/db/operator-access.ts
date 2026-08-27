/**
 * Audited break-glass access across tenant boundaries.
 *
 * `runWithOperatorDatabaseAccess` is the only way to obtain the `operator`
 * database identity (the RLS policies from migration 0073 treat it like
 * `system`). It refuses to run the callback until the bypass is durably
 * recorded in the append-only, hash-chained audit ledger — the ledger's
 * external Redis checkpoint means neither the operator nor the database alone
 * can silently erase the record.
 *
 * Import sites are restricted by src/lib/tenant-boundary.test.ts; extend that
 * registry deliberately when a new operational entry point needs this.
 */

import { getDb } from "@/db";
import { runWithDatabaseIdentity } from "@/db/identity";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";

export interface OperatorAccessGrant {
  /** Who is operating — a person or the invoking script, e.g. "ops:jane" or "script:migrate-custody-encryption". */
  actor: string;
  /** Why the tenant boundary must be crossed. Recorded verbatim in the audit ledger. */
  reason: string;
}

export async function runWithOperatorDatabaseAccess<T>(
  env: Env,
  grant: OperatorAccessGrant,
  fn: () => Promise<T>
): Promise<T> {
  const actor = grant.actor.trim();
  const reason = grant.reason.trim();
  if (!actor || !reason) {
    throw new Error("Operator database access requires a non-empty actor and reason");
  }

  const audit = new AuditService(getDb(env), createKVStoreSet(env).cache);
  return runWithDatabaseIdentity({ kind: "operator", actor, reason }, async () => {
    // Fail closed: if the bypass cannot be recorded, it does not happen.
    await audit.logSystem({
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: `operator-bypass:${actor}`,
      status: "success",
      metadata: {
        tenantIsolationBypass: true,
        actor,
        reason,
      },
    });
    return fn();
  });
}

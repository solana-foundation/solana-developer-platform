import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { DatabaseExecutor } from "@/db/client";
import { currentDatabaseIdentity } from "@/db/identity";
import { TenantScopeViolationError } from "@/lib/tenant-scope";

// Selection and metrics share this predicate: terminal rows and the other environment
// must never inflate a queue the worker cannot drain. No pending-age cutoff.
const PENDING = `WITH pending AS (
  SELECT 'transfer' AS kind, pt.id, pt.organization_id, pt.project_id, pt.updated_at,
    pt.created_at, pt.provider_data->>'fireblocksLastPolledAt' AS last_polled_at
  FROM payment_transfers pt JOIN projects p ON p.id = pt.project_id
  WHERE p.environment = ? AND pt.status = 'processing' AND pt.provider_data->'fireblocksTransfer' IS NOT NULL
  UNION ALL
  SELECT 'signing' AS kind, sp.id, sp.organization_id, sp.project_id, sp.updated_at,
    sp.created_at, sp.last_polled_at
  FROM fireblocks_signing_proposals sp JOIN projects p ON p.id = sp.project_id
  WHERE p.environment = ? AND sp.finished_at IS NULL
)`;

export interface FireblocksReconciliationCandidate {
  kind: "transfer" | "signing";
  id: string;
  organization_id: string;
  project_id: string;
}

/** Cross-tenant queue, callable only by a named system workload. */
export class FireblocksReconciliationRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  private assertSystem() {
    if (currentDatabaseIdentity()?.kind !== "system")
      throw new TenantScopeViolationError("Fireblocks reconciliation is system-only");
  }

  async list(
    environment: SdpEnvironment,
    limit: number
  ): Promise<FireblocksReconciliationCandidate[]> {
    this.assertSystem();
    return this.db.queryMany<FireblocksReconciliationCandidate>(
      `${PENDING}
      SELECT kind, id, organization_id, project_id FROM pending
      ORDER BY updated_at ASC, id ASC, kind ASC LIMIT ?`,
      [environment, environment, limit]
    );
  }

  async stats(environment: SdpEnvironment, now: number) {
    this.assertSystem();
    const row = await this.db.queryOne<{
      pending: number;
      transfers: number;
      signing: number;
      oldest_poll: string | null;
    }>(
      `${PENDING}
      SELECT COUNT(*)::int AS pending, COUNT(*) FILTER (WHERE kind = 'transfer')::int AS transfers,
        COUNT(*) FILTER (WHERE kind = 'signing')::int AS signing,
        MIN(COALESCE(last_polled_at, created_at)) AS oldest_poll FROM pending`,
      [environment, environment]
    );
    if (!row) throw new Error("Missing Fireblocks reconciliation aggregate");
    return {
      pending: row.pending,
      transfers: row.transfers,
      signing: row.signing,
      oldestUnpolledAgeMs:
        row.oldest_poll === null ? 0 : Math.max(0, now - Date.parse(row.oldest_poll)),
    };
  }
}

import { randomUUID } from "node:crypto";
import type { AppDb, DatabaseExecutor } from "@/db";

export const SPONSORSHIP_BREAKER_OPERATOR = "system:sponsorship-breaker";

export type SponsorshipNetwork = "devnet" | "mainnet";
export type SponsorshipBudgetScopeType = "global" | "organization" | "project";
export type SponsorshipReservationStatus =
  | "reserved"
  | "signed"
  | "submitted"
  | "committed"
  | "released"
  | "charged_unknown";

export interface SponsorshipBudgetPolicy {
  id: string;
  network: SponsorshipNetwork;
  scopeType: SponsorshipBudgetScopeType;
  scopeId: string | null;
  enabled: boolean;
  perTransactionLamports: number;
  hourlyLamports: number;
  dailyLamports: number;
  version: number;
  updatedBy: string;
  updateReason: string;
  updatedAt: string;
}

export interface SponsorshipBudgetUsage {
  global: number;
  organization: number;
  project: number;
}

export interface CreateSponsorshipReservationInput {
  id: string;
  network: SponsorshipNetwork;
  productEnvironment: "sandbox" | "production";
  organizationId: string;
  projectId: string | null;
  actorType: string;
  actorId: string;
  transactionDigest: string;
  feePayer: string;
  providerConfigFingerprint: string;
  recentBlockhash: string;
  reservedLamports: number;
  hourBucket: string;
  dayBucket: string;
  policyVersions: Record<string, number>;
}

export interface SponsorshipReservation {
  id: string;
  status: SponsorshipReservationStatus;
  signature: string | null;
  signedTransaction: string | null;
  reservedLamports: number;
  actualLamports: number | null;
  attempt: number;
}

export type SignaturePersistResult = "persisted" | "stale" | "duplicate_signature";

function isDuplicateSignatureError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const pg = error as { code?: string; constraint?: string };
  return pg.code === "23505" && pg.constraint === "idx_sponsorship_budget_reservations_signature";
}

export interface SponsorshipLiveWindowReservation {
  id: string;
  attempt: number;
  reservedLamports: number;
  organizationId: string;
  projectId: string | null;
}

export interface SponsorshipReconciliationReservation extends SponsorshipReservation {
  network: SponsorshipNetwork;
  organizationId: string;
  projectId: string | null;
  feePayer: string;
  providerConfigFingerprint: string;
  recentBlockhash: string;
  hourBucket: string;
  dayBucket: string;
  missCount: number;
  updatedAt: string;
  redisSettledAt: string | null;
}

type PolicyRow = {
  id: string;
  network: SponsorshipNetwork;
  scope_type: SponsorshipBudgetScopeType;
  scope_id: string | null;
  enabled: boolean;
  per_transaction_lamports: number;
  hourly_lamports: number;
  daily_lamports: number;
  version: number;
  updated_by: string;
  update_reason: string;
  updated_at: string;
};

function mapPolicy(row: PolicyRow): SponsorshipBudgetPolicy {
  return {
    id: row.id,
    network: row.network,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    enabled: row.enabled,
    perTransactionLamports: row.per_transaction_lamports,
    hourlyLamports: row.hourly_lamports,
    dailyLamports: row.daily_lamports,
    version: row.version,
    updatedBy: row.updated_by,
    updateReason: row.update_reason,
    updatedAt: row.updated_at,
  };
}

export class SponsorshipBudgetRepository {
  constructor(private readonly db: AppDb) {}

  async getGlobalPolicy(network: SponsorshipNetwork): Promise<SponsorshipBudgetPolicy | null> {
    const row = await this.db.queryOne<PolicyRow>(
      `SELECT * FROM sponsorship_budget_policies
       WHERE network = ? AND scope_type = 'global' AND scope_id IS NULL`,
      [network]
    );
    return row ? mapPolicy(row) : null;
  }

  async listPolicies(network?: SponsorshipNetwork): Promise<SponsorshipBudgetPolicy[]> {
    const rows = await this.db.queryMany<PolicyRow>(
      `SELECT * FROM sponsorship_budget_policies
       WHERE (?::text IS NULL OR network = ?)
       ORDER BY network, CASE scope_type WHEN 'global' THEN 0 WHEN 'organization' THEN 1 ELSE 2 END,
                scope_id NULLS FIRST`,
      [network ?? null, network ?? null]
    );
    return rows.map(mapPolicy);
  }

  async resolvePolicies(input: {
    network: SponsorshipNetwork;
    organizationId: string;
    projectId: string | null;
  }): Promise<SponsorshipBudgetPolicy[]> {
    const rows = await this.db.queryMany<PolicyRow>(
      `SELECT DISTINCT ON (scope_type) *
       FROM sponsorship_budget_policies
       WHERE network = ?
         AND (
           (scope_type = 'global' AND scope_id IS NULL) OR
           (scope_type = 'organization' AND (scope_id = ? OR scope_id IS NULL)) OR
           (scope_type = 'project' AND ?::text IS NOT NULL AND (scope_id = ? OR scope_id IS NULL))
         )
       ORDER BY scope_type, (scope_id IS NOT NULL) DESC`,
      [input.network, input.organizationId, input.projectId, input.projectId]
    );
    const policies = rows.map(mapPolicy);
    const requiredScopes: SponsorshipBudgetScopeType[] = input.projectId
      ? ["global", "organization", "project"]
      : ["global", "organization"];
    if (requiredScopes.some((scopeType) => !policies.some((row) => row.scopeType === scopeType))) {
      throw new Error("Sponsorship budget policy hierarchy is incomplete");
    }
    return requiredScopes.map((scopeType) => {
      const policy = policies.find((row) => row.scopeType === scopeType);
      if (!policy) throw new Error(`Missing ${scopeType} sponsorship policy`);
      return policy;
    });
  }

  async upsertPolicy(input: {
    network: SponsorshipNetwork;
    scopeType: SponsorshipBudgetScopeType;
    scopeId: string | null;
    enabled: boolean;
    perTransactionLamports: number;
    hourlyLamports: number;
    dailyLamports: number;
    operator: string;
    reason: string;
  }): Promise<SponsorshipBudgetPolicy> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.queryOne<PolicyRow>(
        `SELECT * FROM sponsorship_budget_policies
         WHERE network = ? AND scope_type = ? AND scope_id IS NOT DISTINCT FROM ?
         FOR UPDATE`,
        [input.network, input.scopeType, input.scopeId]
      );
      const id = existing?.id ?? `sbp_${randomUUID()}`;
      const version = (existing?.version ?? 0) + 1;
      const row = await tx.queryOne<PolicyRow>(
        `INSERT INTO sponsorship_budget_policies (
           id, network, scope_type, scope_id, enabled, per_transaction_lamports,
           hourly_lamports, daily_lamports, version, updated_by, update_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           per_transaction_lamports = EXCLUDED.per_transaction_lamports,
           hourly_lamports = EXCLUDED.hourly_lamports,
           daily_lamports = EXCLUDED.daily_lamports,
           version = EXCLUDED.version,
           updated_by = EXCLUDED.updated_by,
           update_reason = EXCLUDED.update_reason,
           updated_at = sdp_iso_now()
         RETURNING *`,
        [
          id,
          input.network,
          input.scopeType,
          input.scopeId,
          input.enabled,
          input.perTransactionLamports,
          input.hourlyLamports,
          input.dailyLamports,
          version,
          input.operator,
          input.reason,
        ]
      );
      if (!row) throw new Error("Failed to persist sponsorship budget policy");
      await this.insertRevision(tx, row, input.operator, input.reason);
      return mapPolicy(row);
    });
  }

  async createReservation(input: CreateSponsorshipReservationInput): Promise<boolean> {
    const inserted = await this.db.execute(
      `INSERT INTO sponsorship_budget_reservations (
         id, network, product_environment, organization_id, project_id, actor_type, actor_id,
         transaction_digest, fee_payer, provider_config_fingerprint, recent_blockhash,
         reserved_lamports, hour_bucket, day_bucket, policy_versions, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')
       ON CONFLICT (id) DO NOTHING`,
      [
        input.id,
        input.network,
        input.productEnvironment,
        input.organizationId,
        input.projectId,
        input.actorType,
        input.actorId,
        input.transactionDigest,
        input.feePayer,
        input.providerConfigFingerprint,
        input.recentBlockhash,
        input.reservedLamports,
        input.hourBucket,
        input.dayBucket,
        JSON.stringify(input.policyVersions),
      ]
    );
    return inserted === 1;
  }

  async getReservation(id: string): Promise<SponsorshipReservation | null> {
    const row = await this.db.queryOne<{
      id: string;
      status: SponsorshipReservationStatus;
      signature: string | null;
      signed_transaction: string | null;
      reserved_lamports: number;
      actual_lamports: number | null;
      attempt: number;
    }>(
      `SELECT id, status, signature, signed_transaction, reserved_lamports,
              actual_lamports, attempt
       FROM sponsorship_budget_reservations WHERE id = ?`,
      [id]
    );
    return row
      ? {
          id: row.id,
          status: row.status,
          signature: row.signature,
          signedTransaction: row.signed_transaction,
          reservedLamports: row.reserved_lamports,
          actualLamports: row.actual_lamports,
          attempt: row.attempt,
        }
      : null;
  }

  async reopenReleasedReservation(
    input: CreateSponsorshipReservationInput,
    expectedAttempt: number
  ): Promise<number | null> {
    const updated = await this.db.queryOne<{ attempt: number }>(
      `UPDATE sponsorship_budget_reservations SET
         status = 'reserved', reserved_lamports = ?, actual_lamports = NULL,
         hour_bucket = ?, day_bucket = ?, policy_versions = ?,
         provider_config_fingerprint = ?, signature = NULL,
         signed_transaction = NULL, attempt = attempt + 1, miss_count = 0, failure_reason = NULL,
         submitted_at = NULL, reconciled_at = NULL, redis_settled_at = NULL,
         updated_at = sdp_iso_now()
       WHERE id = ? AND status = 'released' AND attempt = ? AND redis_settled_at IS NOT NULL
       RETURNING attempt`,
      [
        input.reservedLamports,
        input.hourBucket,
        input.dayBucket,
        JSON.stringify(input.policyVersions),
        input.providerConfigFingerprint,
        input.id,
        expectedAttempt,
      ]
    );
    return updated?.attempt ?? null;
  }

  async setPolicyEnabled(input: {
    network: SponsorshipNetwork;
    scopeType: SponsorshipBudgetScopeType;
    scopeId: string | null;
    enabled: boolean;
    operator: string;
    reason: string;
    overwriteDisabledProvenance?: boolean;
  }): Promise<SponsorshipBudgetPolicy | null> {
    const overwriteDisabledProvenance = input.overwriteDisabledProvenance ?? true;
    return this.db.transaction(async (tx) => {
      // A disable over an already-disabled policy must still record who asked
      // and why: auto-recovery resumes only the breaker's config-unavailability
      // trips, so an operator kill or integrity trip layered on top of one has
      // to overwrite that provenance or it would be silently resumed later.
      // The recoverable config-unavailability trip opts out of the overwrite:
      // it must never downgrade a stronger disable to auto-recoverable.
      // Identical repeated disables stay no-ops.
      const row = await tx.queryOne<PolicyRow>(
        `UPDATE sponsorship_budget_policies
           SET enabled = ?, version = version + 1, updated_by = ?, update_reason = ?, updated_at = sdp_iso_now()
         WHERE network = ? AND scope_type = ? AND scope_id IS NOT DISTINCT FROM ?
           AND (enabled <> ?
                OR (? = TRUE AND ? = FALSE AND (updated_by <> ? OR update_reason <> ?)))
         RETURNING *`,
        [
          input.enabled,
          input.operator,
          input.reason,
          input.network,
          input.scopeType,
          input.scopeId,
          input.enabled,
          overwriteDisabledProvenance,
          input.enabled,
          input.operator,
          input.reason,
        ]
      );
      if (!row) return null;
      await this.insertRevision(tx, row, input.operator, input.reason);
      return mapPolicy(row);
    });
  }

  async recordProviderConfigFailure(network: SponsorshipNetwork): Promise<number> {
    const row = await this.db.queryOne<{ consecutive_config_failures: number | string }>(
      `INSERT INTO sponsorship_reconciliation_state (network, consecutive_config_failures)
       VALUES (?, 1)
       ON CONFLICT (network) DO UPDATE
         SET consecutive_config_failures = sponsorship_reconciliation_state.consecutive_config_failures + 1,
             updated_at = sdp_iso_now()
       RETURNING consecutive_config_failures`,
      [network]
    );
    if (!row) {
      throw new Error("Provider config failure counter did not persist");
    }
    return Number(row.consecutive_config_failures);
  }

  async resetProviderConfigFailures(network: SponsorshipNetwork): Promise<void> {
    await this.db.execute(
      `UPDATE sponsorship_reconciliation_state
         SET consecutive_config_failures = 0, updated_at = sdp_iso_now()
       WHERE network = ? AND consecutive_config_failures > 0`,
      [network]
    );
  }

  async tripGlobalBreaker(
    network: SponsorshipNetwork,
    reason: string,
    options: { recoverable?: boolean } = {}
  ): Promise<SponsorshipBudgetPolicy | null> {
    return this.setPolicyEnabled({
      network,
      scopeType: "global",
      scopeId: null,
      enabled: false,
      operator: SPONSORSHIP_BREAKER_OPERATOR,
      reason,
      overwriteDisabledProvenance: !(options.recoverable ?? false),
    });
  }

  async resumeGlobalBreaker(
    network: SponsorshipNetwork,
    expectedTripReason: string,
    reason: string
  ): Promise<SponsorshipBudgetPolicy | null> {
    return this.db.transaction(async (tx) => {
      // Compare-and-set on the trip provenance: an operator kill or integrity
      // trip that lands after the recovery decision changes updated_by or
      // update_reason and must not be overwritten by a stale resume.
      const row = await tx.queryOne<PolicyRow>(
        `UPDATE sponsorship_budget_policies
           SET enabled = TRUE, version = version + 1, updated_by = ?, update_reason = ?, updated_at = sdp_iso_now()
         WHERE network = ? AND scope_type = 'global' AND scope_id IS NULL
           AND enabled = FALSE AND updated_by = ? AND update_reason = ?
         RETURNING *`,
        [
          SPONSORSHIP_BREAKER_OPERATOR,
          reason,
          network,
          SPONSORSHIP_BREAKER_OPERATOR,
          expectedTripReason,
        ]
      );
      if (!row) return null;
      await this.insertRevision(tx, row, SPONSORSHIP_BREAKER_OPERATOR, reason);
      return mapPolicy(row);
    });
  }

  async markSigned(
    id: string,
    expectedAttempt: number,
    signedTransaction: string,
    signature: string
  ): Promise<SignaturePersistResult> {
    try {
      const updated = await this.db.execute(
        `UPDATE sponsorship_budget_reservations
       SET status = 'signed', signed_transaction = ?, signature = ?, updated_at = sdp_iso_now()
       WHERE id = ? AND attempt = ? AND status = 'reserved'`,
        [signedTransaction, signature, id, expectedAttempt]
      );
      return updated === 1 ? "persisted" : "stale";
    } catch (error) {
      if (isDuplicateSignatureError(error)) return "duplicate_signature";
      throw error;
    }
  }

  async markSubmitted(
    id: string,
    expectedAttempt: number,
    signature: string
  ): Promise<SignaturePersistResult> {
    try {
      const updated = await this.db.execute(
        `UPDATE sponsorship_budget_reservations
       SET status = 'submitted', signature = ?, submitted_at = sdp_iso_now(), updated_at = sdp_iso_now()
       WHERE id = ? AND attempt = ? AND status IN ('reserved', 'signed')`,
        [signature, id, expectedAttempt]
      );
      return updated === 1 ? "persisted" : "stale";
    } catch (error) {
      if (isDuplicateSignatureError(error)) return "duplicate_signature";
      throw error;
    }
  }

  async markChargedUnknown(id: string, expectedAttempt: number, reason: string): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE sponsorship_budget_reservations
       SET status = 'charged_unknown', failure_reason = ?, updated_at = sdp_iso_now()
       WHERE id = ? AND attempt = ? AND status IN ('reserved', 'signed', 'submitted')`,
        [reason.slice(0, 500), id, expectedAttempt]
      )) === 1
    );
  }

  async markReleased(id: string, expectedAttempt: number, reason: string): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE sponsorship_budget_reservations
       SET status = 'released', actual_lamports = 0, failure_reason = ?,
           reconciled_at = sdp_iso_now(), updated_at = sdp_iso_now()
       WHERE id = ? AND attempt = ? AND status IN ('reserved', 'signed')`,
        [reason.slice(0, 500), id, expectedAttempt]
      )) === 1
    );
  }

  async getWindowUsage(
    input: {
      network: SponsorshipNetwork;
      organizationId: string;
      projectId: string | null;
      hourBucket: string;
      dayBucket: string;
    },
    executor: DatabaseExecutor = this.db,
    excludeReservationId?: string
  ): Promise<{ hour: SponsorshipBudgetUsage; day: SponsorshipBudgetUsage }> {
    const params: Array<string | null> = [
      input.hourBucket,
      input.hourBucket,
      input.organizationId,
      input.hourBucket,
      input.organizationId,
      input.projectId,
      input.dayBucket,
      input.dayBucket,
      input.organizationId,
      input.dayBucket,
      input.organizationId,
      input.projectId,
      input.network,
      input.hourBucket,
      input.dayBucket,
    ];
    if (excludeReservationId) params.push(excludeReservationId);
    const row = await executor.queryOne<Record<string, number>>(
      `SELECT
         COALESCE(SUM(CASE WHEN hour_bucket = ? THEN COALESCE(actual_lamports, reserved_lamports) ELSE 0 END), 0)::bigint AS global_hour,
         COALESCE(SUM(CASE WHEN hour_bucket = ? AND organization_id = ? THEN COALESCE(actual_lamports, reserved_lamports) ELSE 0 END), 0)::bigint AS organization_hour,
         COALESCE(SUM(CASE WHEN hour_bucket = ? AND organization_id = ? AND project_id IS NOT DISTINCT FROM ? THEN COALESCE(actual_lamports, reserved_lamports) ELSE 0 END), 0)::bigint AS project_hour,
         COALESCE(SUM(CASE WHEN day_bucket = ? THEN COALESCE(actual_lamports, reserved_lamports) ELSE 0 END), 0)::bigint AS global_day,
         COALESCE(SUM(CASE WHEN day_bucket = ? AND organization_id = ? THEN COALESCE(actual_lamports, reserved_lamports) ELSE 0 END), 0)::bigint AS organization_day,
         COALESCE(SUM(CASE WHEN day_bucket = ? AND organization_id = ? AND project_id IS NOT DISTINCT FROM ? THEN COALESCE(actual_lamports, reserved_lamports) ELSE 0 END), 0)::bigint AS project_day
       FROM sponsorship_budget_reservations
       WHERE network = ? AND status <> 'released' AND (hour_bucket = ? OR day_bucket = ?)${
         excludeReservationId ? " AND id <> ?" : ""
}`,
      params
    );
    return {
      hour: {
        global: row?.global_hour ?? 0,
        organization: row?.organization_hour ?? 0,
        project: row?.project_hour ?? 0,
      },
      day: {
        global: row?.global_day ?? 0,
        organization: row?.organization_day ?? 0,
        project: row?.project_day ?? 0,
      },
    };
  }

  async listLiveWindowReservations(
    input: {
      network: SponsorshipNetwork;
      hourBucket: string;
      dayBucket: string;
    },
    executor: DatabaseExecutor = this.db,
    excludeReservationId?: string
  ): Promise<{
    hour: SponsorshipLiveWindowReservation[];
    day: SponsorshipLiveWindowReservation[];
  }> {
    const params: Array<string | null> = [input.network, input.hourBucket, input.dayBucket];
    if (excludeReservationId) params.push(excludeReservationId);
    const rows = await executor.queryMany<{
      id: string;
      attempt: number;
      reserved_lamports: number;
      organization_id: string;
      project_id: string | null;
      hour_bucket: string;
      day_bucket: string;
    }>(
      `SELECT id, attempt, reserved_lamports, organization_id, project_id, hour_bucket, day_bucket
       FROM sponsorship_budget_reservations
       WHERE network = ? AND status IN ('reserved', 'signed', 'submitted')
         AND (hour_bucket = ? OR day_bucket = ?)${excludeReservationId ? " AND id <> ?" : ""}`,
      params
    );
    const hour: SponsorshipLiveWindowReservation[] = [];
    const day: SponsorshipLiveWindowReservation[] = [];
    for (const row of rows) {
      const reservation = {
        id: row.id,
        attempt: row.attempt,
        reservedLamports: row.reserved_lamports,
        organizationId: row.organization_id,
        projectId: row.project_id,
      };
      if (row.hour_bucket === input.hourBucket) {
        hour.push(reservation);
      }
      if (row.day_bucket === input.dayBucket) {
        day.push(reservation);
      }
    }
    return { hour, day };
  }

  async loadWindowAdmissionSnapshot(input: {
    network: SponsorshipNetwork;
    organizationId: string;
    projectId: string | null;
    hourBucket: string;
    dayBucket: string;
    excludeReservationId?: string;
  }): Promise<{
    usage: { hour: SponsorshipBudgetUsage; day: SponsorshipBudgetUsage };
    liveReservations: {
      hour: SponsorshipLiveWindowReservation[];
      day: SponsorshipLiveWindowReservation[];
    };
  }> {
    return this.db.transaction(async (tx) => {
      await tx.queryMany("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const usage = await this.getWindowUsage(input, tx, input.excludeReservationId);
      const liveReservations = await this.listLiveWindowReservations(
        { network: input.network, hourBucket: input.hourBucket, dayBucket: input.dayBucket },
        tx,
        input.excludeReservationId
      );
      return { usage, liveReservations };
    });
  }

  async listReconciliationCandidates(
    network: SponsorshipNetwork,
    updatedBefore: string,
    limit = 250
  ): Promise<SponsorshipReconciliationReservation[]> {
    const rows = await this.db.queryMany<{
      id: string;
      status: SponsorshipReservationStatus;
      signature: string | null;
      signed_transaction: string | null;
      reserved_lamports: number;
      actual_lamports: number | null;
      attempt: number;
      network: SponsorshipNetwork;
      organization_id: string;
      project_id: string | null;
      fee_payer: string;
      provider_config_fingerprint: string;
      recent_blockhash: string;
      hour_bucket: string;
      day_bucket: string;
      miss_count: number;
      updated_at: string;
      redis_settled_at: string | null;
    }>(
      `SELECT id, status, signature, signed_transaction, reserved_lamports, actual_lamports,
              attempt, network,
              organization_id, project_id, fee_payer, provider_config_fingerprint,
              recent_blockhash, hour_bucket, day_bucket,
              miss_count, updated_at, redis_settled_at
       FROM sponsorship_budget_reservations
       WHERE network = ? AND (
         (status IN ('reserved', 'signed', 'submitted') AND updated_at <= ?)
         OR (status IN ('committed', 'released') AND redis_settled_at IS NULL)
       )
       ORDER BY updated_at, id
       LIMIT ?`,
      [network, updatedBefore, limit]
    );
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      signature: row.signature,
      signedTransaction: row.signed_transaction,
      reservedLamports: row.reserved_lamports,
      actualLamports: row.actual_lamports,
      attempt: row.attempt,
      network: row.network,
      organizationId: row.organization_id,
      projectId: row.project_id,
      feePayer: row.fee_payer,
      providerConfigFingerprint: row.provider_config_fingerprint,
      recentBlockhash: row.recent_blockhash,
      hourBucket: row.hour_bucket,
      dayBucket: row.day_bucket,
      missCount: row.miss_count,
      updatedAt: row.updated_at,
      redisSettledAt: row.redis_settled_at,
    }));
  }

  async recordReconciliationMiss(
    id: string,
    expectedAttempt: number,
    expectedMissCount: number
  ): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE sponsorship_budget_reservations
         SET miss_count = miss_count + 1, updated_at = sdp_iso_now()
         WHERE id = ? AND attempt = ? AND miss_count = ? AND status IN ('signed', 'submitted')`,
        [id, expectedAttempt, expectedMissCount]
      )) === 1
    );
  }

  async settleReservation(
    id: string,
    expectedAttempt: number,
    status: "committed" | "released",
    actualLamports: number,
    reason?: string
  ): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE sponsorship_budget_reservations
         SET status = ?, actual_lamports = ?, failure_reason = ?, reconciled_at = sdp_iso_now(),
             updated_at = sdp_iso_now()
         WHERE id = ? AND attempt = ? AND status IN ('signed', 'submitted')`,
        [status, actualLamports, reason ?? null, id, expectedAttempt]
      )) === 1
    );
  }

  async markRedisSettled(id: string, expectedAttempt: number): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE sponsorship_budget_reservations
         SET redis_settled_at = COALESCE(redis_settled_at, sdp_iso_now()),
             updated_at = sdp_iso_now()
         WHERE id = ? AND attempt = ? AND status IN ('committed', 'released')`,
        [id, expectedAttempt]
      )) === 1
    );
  }

  private async insertRevision(
    tx: DatabaseExecutor,
    row: PolicyRow,
    operator: string,
    reason: string
  ): Promise<void> {
    await tx.execute(
      `INSERT INTO sponsorship_budget_policy_revisions (
         id, policy_id, network, scope_type, scope_id, enabled, per_transaction_lamports,
         hourly_lamports, daily_lamports, version, changed_by, change_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `sbpr_${randomUUID()}`,
        row.id,
        row.network,
        row.scope_type,
        row.scope_id,
        row.enabled,
        row.per_transaction_lamports,
        row.hourly_lamports,
        row.daily_lamports,
        row.version,
        operator,
        reason,
      ]
    );
  }
}

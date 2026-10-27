import { randomUUID } from "node:crypto";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { DatabaseClient as AppDb, DatabaseExecutor } from "@/db/client";

export const SPONSORSHIP_BREAKER_OPERATOR = "system:sponsorship-breaker";

export type SponsorshipBudgetScopeType = "global" | "project";
export type SponsorshipReservationStatus =
  | "reserved"
  | "signed"
  | "submitted"
  | "committed"
  | "released"
  | "charged_unknown";

interface SponsorshipBudgetPolicyFields {
  /** The project policy's row id, or the environment itself for a global row (its key). */
  id: string;
  environment: SdpEnvironment;
  enabled: boolean;
  perTransactionLamports: number;
  hourlyLamports: number;
  dailyLamports: number;
  version: number;
  updatedBy: string;
  updateReason: string;
  updatedAt: string;
}

/**
 * An environment's cap (the global row, which also carries the breaker) or one
 * project's cap. A project's environment is its environment's.
 */
export type SponsorshipBudgetPolicy =
  | (SponsorshipBudgetPolicyFields & { scopeType: "global"; projectId: null })
  | (SponsorshipBudgetPolicyFields & { scopeType: "project"; projectId: string });

/**
 * A project with no budget policy. The project-creation trigger writes one for
 * every project, so this is a broken invariant on that one project: its
 * sponsorship refuses, and the environment keeps sponsoring everyone else.
 */
export class SponsorshipProjectPolicyMissingError extends Error {
  constructor(readonly projectId: string) {
    super(`Project ${projectId} has no sponsorship budget policy`);
    this.name = "SponsorshipProjectPolicyMissingError";
  }
}

/** The limits an operator writes to a policy. */
export interface SponsorshipPolicyLimits {
  enabled: boolean;
  perTransactionLamports: number;
  hourlyLamports: number;
  dailyLamports: number;
}

export interface SponsorshipBudgetUsage {
  global: number;
  project: number;
}

export interface CreateSponsorshipReservationInput {
  id: string;
  environment: SdpEnvironment;
  organizationId: string;
  projectId: string;
  actorType: string;
  actorId: string;
  transactionDigest: string;
  feePayer: string;
  providerConfigFingerprint: string;
  recentBlockhash: string;
  lastValidBlockHeight: bigint;
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
  projectId: string;
}

export interface SponsorshipReconciliationReservation extends SponsorshipReservation {
  environment: SdpEnvironment;
  projectId: string;
  feePayer: string;
  providerConfigFingerprint: string;
  /** Null only on rows admitted before migration 0159; a later contract migration deletes them. */
  lastValidBlockHeight: bigint | null;
  hourBucket: string;
  dayBucket: string;
  missCount: number;
  updatedAt: string;
  redisSettledAt: string | null;
}

type PolicyLimitsRow = {
  id: string;
  enabled: boolean;
  per_transaction_lamports: number;
  hourly_lamports: number;
  daily_lamports: number;
  version: number;
  updated_by: string;
  update_reason: string;
  updated_at: string;
};

type GlobalPolicyRow = Omit<PolicyLimitsRow, "id"> & { environment: SdpEnvironment };

type ProjectPolicyRow = PolicyLimitsRow & { project_id: string; environment: SdpEnvironment };

const PROJECT_POLICY_COLUMNS = `pp.id, pp.project_id, pp.enabled, pp.per_transaction_lamports,
  pp.hourly_lamports, pp.daily_lamports, pp.version, pp.updated_by, pp.update_reason,
  pp.updated_at, p.environment`;

/** A new project policy row id. */
function projectPolicyId(): string {
  return `sbpp_${randomUUID()}`;
}

function mapLimits(
  row: Omit<PolicyLimitsRow, "id">
): Omit<SponsorshipBudgetPolicyFields, "id" | "environment"> {
  return {
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

function mapGlobalPolicy(row: GlobalPolicyRow): SponsorshipBudgetPolicy {
  return {
    ...mapLimits(row),
    id: row.environment,
    environment: row.environment,
    scopeType: "global",
    projectId: null,
  };
}

function mapProjectPolicy(row: ProjectPolicyRow): SponsorshipBudgetPolicy {
  return {
    ...mapLimits(row),
    id: row.id,
    environment: row.environment,
    scopeType: "project",
    projectId: row.project_id,
  };
}

export class SponsorshipBudgetRepository {
  constructor(private readonly db: AppDb) {}

  async getGlobalPolicy(environment: SdpEnvironment): Promise<SponsorshipBudgetPolicy | null> {
    const row = await this.db.queryOne<GlobalPolicyRow>(
      "SELECT * FROM sponsorship_budget_policies WHERE environment = ?",
      [environment]
    );
    return row ? mapGlobalPolicy(row) : null;
  }

  /**
   * An environment's global policy and the policy of every project in its environment.
   *
   * @param environment - The SDP environment.
   * @returns The global policy first, then each project's, by project id.
   */
  async listPolicies(environment: SdpEnvironment): Promise<SponsorshipBudgetPolicy[]> {
    const global = await this.getGlobalPolicy(environment);
    const rows = await this.db.queryMany<ProjectPolicyRow>(
      `SELECT ${PROJECT_POLICY_COLUMNS}
       FROM sponsorship_budget_project_policies pp
       JOIN projects p ON p.id = pp.project_id
       WHERE p.environment = ?
       ORDER BY pp.project_id`,
      [environment]
    );
    return [...(global ? [global] : []), ...rows.map(mapProjectPolicy)];
  }

  /**
   * Active projects in an environment with no budget policy. The
   * project-creation trigger writes one for every project, so a non-empty
   * answer is a broken invariant (and those projects' sponsorship refuses).
   *
   * @param environment - The SDP environment.
   * @returns The ids of the active projects that have no policy.
   */
  async listProjectsWithoutPolicy(environment: SdpEnvironment): Promise<string[]> {
    const rows = await this.db.queryMany<{ id: string }>(
      `SELECT p.id
       FROM projects p
       LEFT JOIN sponsorship_budget_project_policies pp ON pp.project_id = p.id
       WHERE p.environment = ? AND p.status = 'active' AND pp.id IS NULL
       ORDER BY p.id`,
      [environment]
    );
    return rows.map((row) => row.id);
  }

  /**
   * One project's policy, provided the project is in the environment's environment.
   *
   * @param input - The environment and project.
   * @param input.environment - The SDP environment the project must belong to.
   * @param input.projectId - The project.
   * @param executor - The client to read through.
   * @returns The project's policy, or null when it has none on that environment.
   */
  async getProjectPolicy(
    input: { environment: SdpEnvironment; projectId: string },
    executor: DatabaseExecutor = this.db
  ): Promise<SponsorshipBudgetPolicy | null> {
    const row = await executor.queryOne<ProjectPolicyRow>(
      `SELECT ${PROJECT_POLICY_COLUMNS}
       FROM sponsorship_budget_project_policies pp
       JOIN projects p ON p.id = pp.project_id
       WHERE pp.project_id = ? AND p.environment = ?`,
      [input.projectId, input.environment]
    );
    return row ? mapProjectPolicy(row) : null;
  }

  /**
   * The global and project policies a sponsorship is admitted against.
   *
   * @param input - The environment and project.
   * @param input.environment - The SDP environment.
   * @param input.projectId - The sponsoring project.
   * @returns The global policy, then the project's.
   * @throws SponsorshipProjectPolicyMissingError when the project has no policy on the environment.
   */
  async resolvePolicies(input: {
    environment: SdpEnvironment;
    projectId: string;
  }): Promise<[SponsorshipBudgetPolicy, SponsorshipBudgetPolicy]> {
    const global = await this.getGlobalPolicy(input.environment);
    if (!global)
      throw new Error(`Sponsorship budget ${input.environment} global policy is missing`);
    const project = await this.getProjectPolicy(input);
    if (!project) throw new SponsorshipProjectPolicyMissingError(input.projectId);
    return [global, project];
  }

  /**
   * Write an environment's global policy as a compare-and-set on the version the
   * operator read. Version 0 means it must not exist yet. A breaker trip bumps
   * the version, so a write computed before the trip refuses rather than
   * silently resuming sponsorship.
   *
   * @param input - The environment, its new limits, the version read, and the attribution.
   * @param input.environment - The SDP environment.
   * @param input.expectedVersion - The version the operator read; 0 when the policy does not exist.
   * @param input.operator - Who made the change.
   * @param input.reason - Why the change was made.
   * @returns The written policy, or null when its version no longer matches.
   */
  async writeGlobalPolicyAtVersion(
    input: SponsorshipPolicyLimits & {
      environment: SdpEnvironment;
      expectedVersion: number;
      operator: string;
      reason: string;
    }
  ): Promise<SponsorshipBudgetPolicy | null> {
    return this.db.transaction(async (tx) => {
      const row =
        input.expectedVersion === 0
          ? await tx.queryOne<GlobalPolicyRow>(
              `INSERT INTO sponsorship_budget_policies (
                 environment, enabled, per_transaction_lamports, hourly_lamports,
                 daily_lamports, version, updated_by, update_reason
               ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
               ON CONFLICT (environment) DO NOTHING
               RETURNING *`,
              [
                input.environment,
                input.enabled,
                input.perTransactionLamports,
                input.hourlyLamports,
                input.dailyLamports,
                input.operator,
                input.reason,
              ]
            )
          : await tx.queryOne<GlobalPolicyRow>(
              `UPDATE sponsorship_budget_policies SET
                 enabled = ?, per_transaction_lamports = ?, hourly_lamports = ?,
                 daily_lamports = ?, version = version + 1, updated_by = ?,
                 update_reason = ?, updated_at = sdp_iso_now()
               WHERE environment = ? AND version = ?
               RETURNING *`,
              [
                input.enabled,
                input.perTransactionLamports,
                input.hourlyLamports,
                input.dailyLamports,
                input.operator,
                input.reason,
                input.environment,
                input.expectedVersion,
              ]
            );
      if (!row) return null;
      await this.insertGlobalRevision(tx, row, input.operator, input.reason);
      return mapGlobalPolicy(row);
    });
  }

  /**
   * Write one project's policy as a compare-and-set on the version the
   * operator read. Every project gets a policy when it is created, so version 0
   * only repairs a project that lost its row.
   *
   * @param input - The project, its new limits, the version read, and the attribution.
   * @param input.projectId - The project.
   * @param input.expectedVersion - The version the operator read; 0 when the policy does not exist.
   * @param input.operator - Who made the change.
   * @param input.reason - Why the change was made.
   * @returns The written policy, or null when its version no longer matches.
   */
  async writeProjectPolicyAtVersion(
    input: SponsorshipPolicyLimits & {
      projectId: string;
      expectedVersion: number;
      operator: string;
      reason: string;
    }
  ): Promise<SponsorshipBudgetPolicy | null> {
    return this.db.transaction(async (tx) => {
      const project = await tx.queryOne<{ environment: SdpEnvironment }>(
        "SELECT environment FROM projects WHERE id = ?",
        [input.projectId]
      );
      if (!project) throw new Error(`Project ${input.projectId} does not exist`);
      const row =
        input.expectedVersion === 0
          ? await tx.queryOne<PolicyLimitsRow & { project_id: string }>(
              `INSERT INTO sponsorship_budget_project_policies (
                 id, project_id, enabled, per_transaction_lamports, hourly_lamports,
                 daily_lamports, version, updated_by, update_reason
               ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
               ON CONFLICT (project_id) DO NOTHING
               RETURNING *`,
              [
                projectPolicyId(),
                input.projectId,
                input.enabled,
                input.perTransactionLamports,
                input.hourlyLamports,
                input.dailyLamports,
                input.operator,
                input.reason,
              ]
            )
          : await tx.queryOne<PolicyLimitsRow & { project_id: string }>(
              `UPDATE sponsorship_budget_project_policies SET
                 enabled = ?, per_transaction_lamports = ?, hourly_lamports = ?,
                 daily_lamports = ?, version = version + 1, updated_by = ?,
                 update_reason = ?, updated_at = sdp_iso_now()
               WHERE project_id = ? AND version = ?
               RETURNING *`,
              [
                input.enabled,
                input.perTransactionLamports,
                input.hourlyLamports,
                input.dailyLamports,
                input.operator,
                input.reason,
                input.projectId,
                input.expectedVersion,
              ]
            );
      if (!row) return null;
      await this.insertProjectRevision(tx, row, input.operator, input.reason);
      return mapProjectPolicy({ ...row, environment: project.environment });
    });
  }

  /**
   * Resume an environment's global policy as a compare-and-set on the version the
   * operator read, whatever disabled it: an operator may resume an integrity
   * trip, which the breaker's own recovery (`resumeGlobalBreaker`) refuses.
   *
   * @param input - The environment, the version the operator read, and the attribution.
   * @param input.environment - The SDP environment to resume.
   * @param input.expectedVersion - The global policy version the operator read.
   * @param input.operator - Who resumed sponsorship.
   * @param input.reason - Why sponsorship was resumed.
   * @returns The resumed policy, or null when it is enabled or its version moved.
   */
  async resumeGlobalPolicyAtVersion(input: {
    environment: SdpEnvironment;
    expectedVersion: number;
    operator: string;
    reason: string;
  }): Promise<SponsorshipBudgetPolicy | null> {
    return this.db.transaction(async (tx) => {
      const row = await tx.queryOne<GlobalPolicyRow>(
        `UPDATE sponsorship_budget_policies
           SET enabled = TRUE, version = version + 1, updated_by = ?, update_reason = ?, updated_at = sdp_iso_now()
         WHERE environment = ? AND enabled = FALSE AND version = ?
         RETURNING *`,
        [input.operator, input.reason, input.environment, input.expectedVersion]
      );
      if (!row) return null;
      await this.insertGlobalRevision(tx, row, input.operator, input.reason);
      return mapGlobalPolicy(row);
    });
  }

  async createReservation(input: CreateSponsorshipReservationInput): Promise<boolean> {
    const inserted = await this.db.execute(
      `INSERT INTO sponsorship_budget_reservations (
         id, environment, organization_id, project_id, actor_type, actor_id,
         transaction_digest, fee_payer, provider_config_fingerprint, recent_blockhash,
         last_valid_block_height, reserved_lamports, hour_bucket, day_bucket, policy_versions,
         status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')
       ON CONFLICT (id) DO NOTHING`,
      [
        input.id,
        input.environment,
        input.organizationId,
        input.projectId,
        input.actorType,
        input.actorId,
        input.transactionDigest,
        input.feePayer,
        input.providerConfigFingerprint,
        input.recentBlockhash,
        input.lastValidBlockHeight.toString(),
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
    // last_valid_block_height stays: the row id hashes the message digest, so a reopened row
    // sponsors the same blockhash and its stored bound still holds.
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

  async setGlobalPolicyEnabled(input: {
    environment: SdpEnvironment;
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
      const row = await tx.queryOne<GlobalPolicyRow>(
        `UPDATE sponsorship_budget_policies
           SET enabled = ?, version = version + 1, updated_by = ?, update_reason = ?, updated_at = sdp_iso_now()
         WHERE environment = ?
           AND (enabled <> ?
                OR (? = TRUE AND ? = FALSE AND (updated_by <> ? OR update_reason <> ?)))
         RETURNING *`,
        [
          input.enabled,
          input.operator,
          input.reason,
          input.environment,
          input.enabled,
          overwriteDisabledProvenance,
          input.enabled,
          input.operator,
          input.reason,
        ]
      );
      if (!row) return null;
      await this.insertGlobalRevision(tx, row, input.operator, input.reason);
      return mapGlobalPolicy(row);
    });
  }

  async recordProviderConfigFailure(environment: SdpEnvironment): Promise<number> {
    const row = await this.db.queryOne<{ consecutive_config_failures: number | string }>(
      `INSERT INTO sponsorship_reconciliation_state (environment, consecutive_config_failures)
       VALUES (?, 1)
       ON CONFLICT (environment) DO UPDATE
         SET consecutive_config_failures = sponsorship_reconciliation_state.consecutive_config_failures + 1,
             updated_at = sdp_iso_now()
       RETURNING consecutive_config_failures`,
      [environment]
    );
    if (!row) {
      throw new Error("Provider config failure counter did not persist");
    }
    return Number(row.consecutive_config_failures);
  }

  async resetProviderConfigFailures(environment: SdpEnvironment): Promise<void> {
    await this.db.execute(
      `UPDATE sponsorship_reconciliation_state
         SET consecutive_config_failures = 0, updated_at = sdp_iso_now()
       WHERE environment = ? AND consecutive_config_failures > 0`,
      [environment]
    );
  }

  async tripGlobalBreaker(
    environment: SdpEnvironment,
    reason: string,
    options: { recoverable?: boolean } = {}
  ): Promise<SponsorshipBudgetPolicy | null> {
    return this.setGlobalPolicyEnabled({
      environment,
      enabled: false,
      operator: SPONSORSHIP_BREAKER_OPERATOR,
      reason,
      overwriteDisabledProvenance: !(options.recoverable ?? false),
    });
  }

  async resumeGlobalBreaker(
    environment: SdpEnvironment,
    expectedTripReason: string,
    reason: string
  ): Promise<SponsorshipBudgetPolicy | null> {
    return this.db.transaction(async (tx) => {
      // Compare-and-set on the trip provenance: an operator kill or integrity
      // trip that lands after the recovery decision changes updated_by or
      // update_reason and must not be overwritten by a stale resume.
      const row = await tx.queryOne<GlobalPolicyRow>(
        `UPDATE sponsorship_budget_policies
           SET enabled = TRUE, version = version + 1, updated_by = ?, update_reason = ?, updated_at = sdp_iso_now()
         WHERE environment = ? AND enabled = FALSE AND updated_by = ? AND update_reason = ?
         RETURNING *`,
        [
          SPONSORSHIP_BREAKER_OPERATOR,
          reason,
          environment,
          SPONSORSHIP_BREAKER_OPERATOR,
          expectedTripReason,
        ]
      );
      if (!row) return null;
      await this.insertGlobalRevision(tx, row, SPONSORSHIP_BREAKER_OPERATOR, reason);
      return mapGlobalPolicy(row);
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
      environment: SdpEnvironment;
      organizationId: string;
      projectId: string;
      hourBucket: string;
      dayBucket: string;
    },
    executor: DatabaseExecutor = this.db,
    excludeReservationId?: string
  ): Promise<{ hour: SponsorshipBudgetUsage; day: SponsorshipBudgetUsage }> {
    const params: string[] = [
      input.hourBucket,
      input.hourBucket,
      input.organizationId,
      input.projectId,
      input.dayBucket,
      input.dayBucket,
      input.organizationId,
      input.projectId,
      input.environment,
      input.hourBucket,
      input.dayBucket,
    ];
    if (excludeReservationId) params.push(excludeReservationId);
    const row = await executor.queryOne<Record<string, number>>(
      `SELECT
         COALESCE(SUM(CASE WHEN hour_bucket = ? THEN COALESCE(actual_lamports, reserved_lamports) ELSE 0 END), 0)::bigint AS global_hour,
         COALESCE(SUM(CASE WHEN hour_bucket = ? AND organization_id = ? AND project_id = ? THEN COALESCE(actual_lamports, reserved_lamports) ELSE 0 END), 0)::bigint AS project_hour,
         COALESCE(SUM(CASE WHEN day_bucket = ? THEN COALESCE(actual_lamports, reserved_lamports) ELSE 0 END), 0)::bigint AS global_day,
         COALESCE(SUM(CASE WHEN day_bucket = ? AND organization_id = ? AND project_id = ? THEN COALESCE(actual_lamports, reserved_lamports) ELSE 0 END), 0)::bigint AS project_day
       FROM sponsorship_budget_reservations
       WHERE environment = ? AND status <> 'released' AND (hour_bucket = ? OR day_bucket = ?)${
         excludeReservationId ? " AND id <> ?" : ""
       }`,
      params
    );
    return {
      hour: {
        global: row?.global_hour ?? 0,
        project: row?.project_hour ?? 0,
      },
      day: {
        global: row?.global_day ?? 0,
        project: row?.project_day ?? 0,
      },
    };
  }

  async listLiveWindowReservations(
    input: {
      environment: SdpEnvironment;
      hourBucket: string;
      dayBucket: string;
    },
    executor: DatabaseExecutor = this.db,
    excludeReservationId?: string
  ): Promise<{
    hour: SponsorshipLiveWindowReservation[];
    day: SponsorshipLiveWindowReservation[];
  }> {
    const params: string[] = [input.environment, input.hourBucket, input.dayBucket];
    if (excludeReservationId) params.push(excludeReservationId);
    const rows = await executor.queryMany<{
      id: string;
      attempt: number;
      reserved_lamports: number;
      project_id: string;
      hour_bucket: string;
      day_bucket: string;
    }>(
      `SELECT id, attempt, reserved_lamports, project_id, hour_bucket, day_bucket
       FROM sponsorship_budget_reservations
       WHERE environment = ? AND status IN ('reserved', 'signed', 'submitted')
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
    environment: SdpEnvironment;
    organizationId: string;
    projectId: string;
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
        {
          environment: input.environment,
          hourBucket: input.hourBucket,
          dayBucket: input.dayBucket,
        },
        tx,
        input.excludeReservationId
      );
      return { usage, liveReservations };
    });
  }

  async listReconciliationCandidates(
    environment: SdpEnvironment,
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
      environment: SdpEnvironment;
      project_id: string;
      fee_payer: string;
      provider_config_fingerprint: string;
      last_valid_block_height: string | null;
      hour_bucket: string;
      day_bucket: string;
      miss_count: number;
      updated_at: string;
      redis_settled_at: string | null;
    }>(
      `SELECT id, status, signature, signed_transaction, reserved_lamports, actual_lamports,
              attempt, environment,
              project_id, fee_payer, provider_config_fingerprint,
              last_valid_block_height, hour_bucket, day_bucket,
              miss_count, updated_at, redis_settled_at
       FROM sponsorship_budget_reservations
       WHERE environment = ? AND (
         (status IN ('reserved', 'signed', 'submitted') AND updated_at <= ?)
         OR (status IN ('committed', 'released') AND redis_settled_at IS NULL)
       )
       ORDER BY updated_at, id
       LIMIT ?`,
      [environment, updatedBefore, limit]
    );
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      signature: row.signature,
      signedTransaction: row.signed_transaction,
      reservedLamports: row.reserved_lamports,
      actualLamports: row.actual_lamports,
      attempt: row.attempt,
      environment: row.environment,
      projectId: row.project_id,
      feePayer: row.fee_payer,
      providerConfigFingerprint: row.provider_config_fingerprint,
      lastValidBlockHeight:
        row.last_valid_block_height === null ? null : BigInt(row.last_valid_block_height),
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

  private async insertGlobalRevision(
    tx: DatabaseExecutor,
    row: GlobalPolicyRow,
    operator: string,
    reason: string
  ): Promise<void> {
    await tx.execute(
      `INSERT INTO sponsorship_budget_policy_revisions (
         id, environment, enabled, per_transaction_lamports,
         hourly_lamports, daily_lamports, version, changed_by, change_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `sbpr_${randomUUID()}`,
        row.environment,
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

  private async insertProjectRevision(
    tx: DatabaseExecutor,
    row: PolicyLimitsRow & { project_id: string },
    operator: string,
    reason: string
  ): Promise<void> {
    await tx.execute(
      `INSERT INTO sponsorship_budget_project_policy_revisions (
         id, policy_id, project_id, enabled, per_transaction_lamports,
         hourly_lamports, daily_lamports, version, changed_by, change_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `sbppr_${randomUUID()}`,
        row.id,
        row.project_id,
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

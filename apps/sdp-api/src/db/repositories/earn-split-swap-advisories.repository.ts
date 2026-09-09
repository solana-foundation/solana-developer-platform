import type { SdpEnvironment } from "@sdp/types";
import type { AppDb } from "@/db";

/**
 * Orphaned split-swap advisories (PRO-1864): the record that SDP handed a
 * partner a standalone swap to broadcast itself.
 *
 * NOT part of the movement ledger, NOT a consumable build, and deliberately its
 * own repository: a row here says "a swap was handed out", never that money
 * moved. The detector that reads it writes nothing but back to this table.
 *
 * Every amount here is a BASE-UNIT integer string of the deposit mint except
 * the two `*_amount` columns, which are the decimal strings the partner was
 * shown and exist for display only. The detector compares atoms to atoms.
 */

export const EARN_SPLIT_SWAP_ADVISORY_ID_PREFIX = "earn_split_swap_advisory_";

export function generateEarnSplitSwapAdvisoryId(): string {
  return `${EARN_SPLIT_SWAP_ADVISORY_ID_PREFIX}${crypto.randomUUID()}`;
}

export type EarnSplitSwapAdvisoryResolution = "deposit_observed" | "unfunded" | "acknowledged";

export interface EarnSplitSwapAdvisoryRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  provider: string;
  strategy_id: string;
  vault_address: string;
  owner_address: string;
  source_token_mint: string;
  deposit_token_mint: string;
  deposit_token_decimals: number;
  swap_source_amount: string;
  swap_min_out_amount: string;
  swap_min_out_atoms: string;
  /** NUMERIC in Postgres, read back as a string so uint64 round-trips exactly. */
  swap_last_valid_block_height: string;
  fee_payer: string | null;
  baseline_deposit_token_atoms: string;
  created_by: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  last_checked_at: string | null;
  last_observed_atoms: string | null;
  last_follow_up_build_at: string | null;
  first_flagged_at: string | null;
  resolved_at: string | null;
  resolution: EarnSplitSwapAdvisoryResolution | null;
  resolved_by: string | null;
  resolving_movement_id: string | null;
}

export interface CreateEarnSplitSwapAdvisoryInput {
  id: string;
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  strategyId: string;
  vaultAddress: string;
  ownerAddress: string;
  sourceTokenMint: string;
  depositTokenMint: string;
  depositTokenDecimals: number;
  swapSourceAmount: string;
  swapMinOutAmount: string;
  swapMinOutAtoms: string;
  swapLastValidBlockHeight: string;
  feePayer?: string | null;
  baselineDepositTokenAtoms: string;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface EarnSplitSwapAdvisoriesRepository {
  create(input: CreateEarnSplitSwapAdvisoryInput): Promise<EarnSplitSwapAdvisoryRow>;
  /**
   * The detector's batch: open rows, least-recently-visited first, and every
   * returned row's `last_checked_at` advanced in the same statement so an
   * orphan that stays open rotates behind its peers instead of pinning the
   * head of the queue (the fairness cursor `claimUnsettledVaultMovements`
   * uses). A cursor, not a lease: nothing else is excluded by it.
   */
  claimOpenForDetection(limit: number): Promise<EarnSplitSwapAdvisoryRow[]>;
  countOpen(): Promise<number>;
  /** Stamp what a visit observed without resolving. */
  recordObservation(params: {
    advisoryId: string;
    observedAtoms: string | null;
    followUpBuildAt: string | null;
    flagged: boolean;
  }): Promise<void>;
  resolve(params: {
    advisoryId: string;
    resolution: EarnSplitSwapAdvisoryResolution;
    resolvedBy: string;
    resolvingMovementId?: string | null;
    observedAtoms?: string | null;
  }): Promise<EarnSplitSwapAdvisoryRow | null>;
  /**
   * Newest UNCONSUMED follow-up BUILD for the advisory's owner and deposit
   * token created after the advisory, or null. An unconsumed build proves the
   * partner is alive and past the swap while the movement does not exist yet
   * (it appears only at submit). A consumed build is deliberately excluded:
   * its movement's STATUS is the evidence then, and a failed one must not keep
   * the advisory pending.
   */
  findFollowUpBuildAt(params: {
    organizationId: string;
    projectId: string | null;
    environment: SdpEnvironment;
    ownerAddress: string;
    depositTokenMint: string;
    createdAfter: string;
  }): Promise<string | null>;
}

function mapRow(row: Record<string, unknown>): EarnSplitSwapAdvisoryRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: (row.project_id as string | null) ?? null,
    environment: row.environment as SdpEnvironment,
    provider: row.provider as string,
    strategy_id: row.strategy_id as string,
    vault_address: row.vault_address as string,
    owner_address: row.owner_address as string,
    source_token_mint: row.source_token_mint as string,
    deposit_token_mint: row.deposit_token_mint as string,
    deposit_token_decimals: Number(row.deposit_token_decimals),
    swap_source_amount: row.swap_source_amount as string,
    swap_min_out_amount: row.swap_min_out_amount as string,
    swap_min_out_atoms: String(row.swap_min_out_atoms),
    swap_last_valid_block_height: String(row.swap_last_valid_block_height),
    fee_payer: (row.fee_payer as string | null) ?? null,
    baseline_deposit_token_atoms: String(row.baseline_deposit_token_atoms),
    created_by: (row.created_by as string | null) ?? null,
    initiated_by_key_id: (row.initiated_by_key_id as string | null) ?? null,
    created_at: row.created_at as string,
    last_checked_at: (row.last_checked_at as string | null) ?? null,
    last_observed_atoms: row.last_observed_atoms == null ? null : String(row.last_observed_atoms),
    last_follow_up_build_at: (row.last_follow_up_build_at as string | null) ?? null,
    first_flagged_at: (row.first_flagged_at as string | null) ?? null,
    resolved_at: (row.resolved_at as string | null) ?? null,
    resolution: (row.resolution as EarnSplitSwapAdvisoryResolution | null) ?? null,
    resolved_by: (row.resolved_by as string | null) ?? null,
    resolving_movement_id: (row.resolving_movement_id as string | null) ?? null,
  };
}

export function createPostgresEarnSplitSwapAdvisoriesRepository(
  db: AppDb
): EarnSplitSwapAdvisoriesRepository {
  return {
    async create(input) {
      const row = await db
        .prepare(
          `INSERT INTO earn_split_swap_advisories (
             id, organization_id, project_id, environment, provider, strategy_id,
             vault_address, owner_address, source_token_mint, deposit_token_mint,
             deposit_token_decimals, swap_source_amount, swap_min_out_amount,
             swap_min_out_atoms, swap_last_valid_block_height, fee_payer,
             baseline_deposit_token_atoms, created_by, initiated_by_key_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.environment,
          input.provider,
          input.strategyId,
          input.vaultAddress,
          input.ownerAddress,
          input.sourceTokenMint,
          input.depositTokenMint,
          input.depositTokenDecimals,
          input.swapSourceAmount,
          input.swapMinOutAmount,
          input.swapMinOutAtoms,
          input.swapLastValidBlockHeight,
          input.feePayer ?? null,
          input.baselineDepositTokenAtoms,
          input.createdBy ?? null,
          input.initiatedByKeyId ?? null
        )
        .first<Record<string, unknown>>();
      if (!row) {
        throw new Error("Failed to record the earn split-swap advisory");
      }
      return mapRow(row);
    },

    async claimOpenForDetection(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
        throw new Error("claimOpenForDetection limit must be an integer from 1 to 256");
      }
      const result = await db
        .prepare(
          `WITH visited AS (
             SELECT id FROM earn_split_swap_advisories
              WHERE resolved_at IS NULL
              ORDER BY COALESCE(last_checked_at, created_at) ASC, created_at ASC, id ASC
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           ), touched AS (
             UPDATE earn_split_swap_advisories advisory
                SET last_checked_at = sdp_iso_now()
               FROM visited
              WHERE advisory.id = visited.id
             RETURNING advisory.*
           )
           SELECT * FROM touched ORDER BY created_at ASC, id ASC`
        )
        .bind(limit)
        .all<Record<string, unknown>>();
      return (result.results ?? []).map(mapRow);
    },

    async countOpen() {
      const row = await db
        .prepare(
          "SELECT COUNT(*) AS open FROM earn_split_swap_advisories WHERE resolved_at IS NULL"
        )
        .first<{ open: number | string }>();
      return Number(row?.open ?? 0);
    },

    async recordObservation(params) {
      await db
        .prepare(
          `UPDATE earn_split_swap_advisories
              SET last_observed_atoms = COALESCE(?, last_observed_atoms),
                  last_follow_up_build_at = COALESCE(?, last_follow_up_build_at),
                  first_flagged_at = CASE WHEN ? THEN COALESCE(first_flagged_at, sdp_iso_now()) ELSE first_flagged_at END
            WHERE id = ? AND resolved_at IS NULL`
        )
        .bind(params.observedAtoms, params.followUpBuildAt, params.flagged, params.advisoryId)
        .run();
    },

    async resolve(params) {
      const row = await db
        .prepare(
          `UPDATE earn_split_swap_advisories
              SET resolved_at = sdp_iso_now(),
                  resolution = ?,
                  resolved_by = ?,
                  resolving_movement_id = ?,
                  last_observed_atoms = COALESCE(?, last_observed_atoms)
            WHERE id = ? AND resolved_at IS NULL
            RETURNING *`
        )
        .bind(
          params.resolution,
          params.resolvedBy,
          params.resolvingMovementId ?? null,
          params.observedAtoms ?? null,
          params.advisoryId
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async findFollowUpBuildAt(params) {
      const row = await db
        .prepare(
          `SELECT created_at FROM earn_external_wallet_transactions
            WHERE organization_id = ?
              AND project_id IS NOT DISTINCT FROM ?
              AND environment = ?
              AND owner_address = ?
              AND direction = 'deposit'
              AND token_mint = ?
              AND movement_id IS NULL
              AND created_at > ?
            ORDER BY created_at DESC
            LIMIT 1`
        )
        .bind(
          params.organizationId,
          params.projectId,
          params.environment,
          params.ownerAddress,
          params.depositTokenMint,
          params.createdAfter
        )
        .first<{ created_at: string }>();
      return row?.created_at ?? null;
    },
  };
}

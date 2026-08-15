import type { SdpEnvironment } from "@sdp/types";
import type { AppDb } from "@/db";

/**
 * Persistence for NON-CUSTODIAL ("vault_direct") Earn positions and the money
 * SDP itself moves into and out of them (migration 0058).
 *
 * Kept out of `earn.repository.ts` deliberately: that file models the custodial
 * program — a provider-provisioned wallet with a fundable address, uniquely
 * claimed platform-wide. These tables model the opposite shape, and the
 * constraint that differs (many orgs may hold the same public vault) is the
 * whole reason they are separate. Mixing them invites someone to "unify" the
 * two uniques, which would lock a permissionless vault to its first depositor.
 */

export function generateEarnVaultPositionId(): string {
  return `earn_vault_position_${crypto.randomUUID()}`;
}

export function generateEarnVaultMovementId(): string {
  return `earn_vault_movement_${crypto.randomUUID()}`;
}

export type EarnVaultMovementDirection = "deposit" | "withdraw";
export type EarnVaultMovementStatus = "pending" | "submitted" | "confirmed" | "failed";

export interface EarnVaultPositionRow {
  id: string;
  organization_id: string;
  project_id: string;
  environment: SdpEnvironment;
  provider: string;
  provider_reference: string;
  custody_wallet_id: string;
  share_mint: string | null;
  token_mint: string | null;
  label: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface EarnVaultMovementRow {
  id: string;
  organization_id: string;
  project_id: string;
  environment: SdpEnvironment;
  position_id: string;
  provider: string;
  provider_reference: string;
  custody_wallet_id: string;
  direction: EarnVaultMovementDirection;
  status: EarnVaultMovementStatus;
  amount: string | null;
  shares: string | null;
  signature: string | null;
  failure_reason: string | null;
  request_id: string;
  created_by: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
}

export interface ClaimEarnVaultPositionInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  providerReference: string;
  custodyWalletId: string;
  shareMint?: string | null;
  tokenMint?: string | null;
  label?: string | null;
  createdBy?: string | null;
}

export interface CreateEarnVaultMovementInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  positionId: string;
  provider: string;
  providerReference: string;
  custodyWalletId: string;
  direction: EarnVaultMovementDirection;
  requestId: string;
  amount?: string | null;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface AdvanceEarnVaultMovementInput {
  movementId: string;
  organizationId: string;
  /**
   * The states this transition is legal FROM. The guard is the point: two
   * observers (the submit path and the confirmation sweep) race on the same row,
   * and a blind UPDATE would let a late failure overwrite a settled success.
   */
  fromStatuses: readonly EarnVaultMovementStatus[];
  toStatus: EarnVaultMovementStatus;
  signature?: string | null;
  shares?: string | null;
  failureReason?: string | null;
  confirmedAt?: string | null;
}

export interface EarnVaultRepository {
  /**
   * Record that an org holds a vault from a wallet, or return the existing row.
   *
   * Idempotent by design (`ON CONFLICT … DO UPDATE`): opening a position is not
   * the money movement — the deposit is — so a second deposit into the same
   * vault from the same wallet must find the same position rather than fail.
   */
  claimPosition(input: ClaimEarnVaultPositionInput): Promise<EarnVaultPositionRow>;
  getPositionById(params: {
    organizationId: string;
    environment: SdpEnvironment;
    positionId: string;
  }): Promise<EarnVaultPositionRow | null>;
  listPositions(params: {
    organizationId: string;
    environment: SdpEnvironment;
  }): Promise<EarnVaultPositionRow[]>;

  /**
   * Write the intent row BEFORE anything is signed.
   *
   * Returns the existing row on an idempotency-key collision instead of
   * throwing: that is what makes a retried deposit safe. The chain has no
   * request-id dedupe, so this row is the only thing standing between a retry
   * and a second real transfer.
   */
  createMovement(
    input: CreateEarnVaultMovementInput
  ): Promise<{ row: EarnVaultMovementRow; replayed: boolean }>;
  /** Guarded CAS. Returns null when the row was not in `fromStatuses`. */
  advanceMovement(input: AdvanceEarnVaultMovementInput): Promise<EarnVaultMovementRow | null>;
  listMovements(params: {
    organizationId: string;
    positionId: string;
    limit?: number;
  }): Promise<EarnVaultMovementRow[]>;
}

export function createPostgresEarnVaultRepository(db: AppDb): EarnVaultRepository {
  return {
    async claimPosition(input) {
      const id = generateEarnVaultPositionId();
      const row = await db
        .prepare(
          `INSERT INTO earn_vault_positions (
             id, organization_id, project_id, environment,
             provider, provider_reference, custody_wallet_id,
             share_mint, token_mint, label, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (organization_id, environment, provider, provider_reference, custody_wallet_id)
           DO UPDATE SET
             updated_at = sdp_iso_now(),
             -- Re-entering a fully-exited position reopens the same row rather
             -- than stranding history under a closed one.
             closed_at = NULL,
             -- COALESCE keeps a previously-learned mint when a later claim omits
             -- it; never overwrite known chain identity with NULL.
             share_mint = COALESCE(EXCLUDED.share_mint, earn_vault_positions.share_mint),
             token_mint = COALESCE(EXCLUDED.token_mint, earn_vault_positions.token_mint),
             label = COALESCE(EXCLUDED.label, earn_vault_positions.label)
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.environment,
          input.provider,
          input.providerReference,
          input.custodyWalletId,
          input.shareMint ?? null,
          input.tokenMint ?? null,
          input.label ?? null,
          input.createdBy ?? null
        )
        .first<EarnVaultPositionRow>();
      if (!row) throw new Error("Failed to claim earn vault position");
      return row;
    },

    async getPositionById(params) {
      return await db
        .prepare(
          `SELECT * FROM earn_vault_positions
           WHERE id = ? AND organization_id = ? AND environment = ?`
        )
        .bind(params.positionId, params.organizationId, params.environment)
        .first<EarnVaultPositionRow>();
    },

    async listPositions(params) {
      const result = await db
        .prepare(
          `SELECT * FROM earn_vault_positions
           WHERE organization_id = ? AND environment = ?
           ORDER BY created_at DESC, id DESC`
        )
        .bind(params.organizationId, params.environment)
        .all<EarnVaultPositionRow>();
      return result.results ?? [];
    },

    async createMovement(input) {
      const id = generateEarnVaultMovementId();
      const inserted = await db
        .prepare(
          `INSERT INTO earn_vault_movements (
             id, organization_id, project_id, environment, position_id,
             provider, provider_reference, custody_wallet_id,
             direction, request_id, amount, created_by, initiated_by_key_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (organization_id, request_id) DO NOTHING
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.environment,
          input.positionId,
          input.provider,
          input.providerReference,
          input.custodyWalletId,
          input.direction,
          input.requestId,
          input.amount ?? null,
          input.createdBy ?? null,
          input.initiatedByKeyId ?? null
        )
        .first<EarnVaultMovementRow>();

      if (inserted) return { row: inserted, replayed: false };

      // DO NOTHING means the key was already used. Return that row — the caller
      // reports the original movement rather than moving money a second time.
      const existing = await db
        .prepare(`SELECT * FROM earn_vault_movements WHERE organization_id = ? AND request_id = ?`)
        .bind(input.organizationId, input.requestId)
        .first<EarnVaultMovementRow>();
      if (!existing) throw new Error("Failed to create earn vault movement");
      return { row: existing, replayed: true };
    },

    async advanceMovement(input) {
      const assignments = ["status = ?", "updated_at = sdp_iso_now()"];
      const values: unknown[] = [input.toStatus];
      // `undefined` means "leave alone"; an explicit null is a real write.
      if (input.signature !== undefined) {
        assignments.push("signature = ?");
        values.push(input.signature);
      }
      if (input.shares !== undefined) {
        assignments.push("shares = ?");
        values.push(input.shares);
      }
      if (input.failureReason !== undefined) {
        assignments.push("failure_reason = ?");
        values.push(input.failureReason);
      }
      if (input.confirmedAt !== undefined) {
        assignments.push("confirmed_at = ?");
        values.push(input.confirmedAt);
      }

      const guards = input.fromStatuses.map(() => "?").join(", ");
      return await db
        .prepare(
          `UPDATE earn_vault_movements
             SET ${assignments.join(", ")}
           WHERE id = ? AND organization_id = ? AND status IN (${guards})
           RETURNING *`
        )
        .bind(...values, input.movementId, input.organizationId, ...input.fromStatuses)
        .first<EarnVaultMovementRow>();
    },

    async listMovements(params) {
      const result = await db
        .prepare(
          `SELECT * FROM earn_vault_movements
           WHERE organization_id = ? AND position_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        )
        .bind(params.organizationId, params.positionId, params.limit ?? 50)
        .all<EarnVaultMovementRow>();
      return result.results ?? [];
    },
  };
}

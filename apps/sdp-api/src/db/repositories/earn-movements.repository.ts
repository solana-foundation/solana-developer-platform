import type {
  EarnExecutionModel,
  EarnMovementDirection,
  EarnMovementStatus,
  SdpEnvironment,
} from "@sdp/types";
import type { AppDb } from "@/db";

/**
 * The unified Earn movement ledger (PRO-1705, migrations 0062-0064).
 *
 * `earn_movements` is the single authoritative record of every Earn money
 * movement — both directions, both execution models — and `earn_positions` is
 * the single holdings table behind it. This module owns writing them.
 *
 * ── What this module is, during the transition ────────────────────────────
 * The legacy tables (`earn_program_withdrawals`, `earn_vault_movements`,
 * `earn_vault_positions`) are still the authoritative writers and readers. This
 * module MIRRORS each of their writes into the unified shape, in the SAME
 * transaction, so the new tables are continuously current before any read
 * switches to them. The invariant is exactly:
 *
 *     a unified row IS the projection of its legacy row
 *
 * which is why every function here re-projects the whole row rather than
 * patching the columns that happened to change. A row that a previous revision
 * wrote without mirroring (a rollback window, an older deploy) is repaired by
 * the next write that touches it, and the bulk backfill in 0064 is the same
 * projection applied to everything at once.
 *
 * ── The projections live in SQL, not here ─────────────────────────────────
 * Every mapping decision — which legacy status becomes which unified one, which
 * join supplies the denomination, whether a settled amount is known yet — is a
 * view created in migration 0063 and shared with the bulk backfill. That is
 * deliberate: a projection spelled once in SQL and once in TypeScript would
 * drift, and "history" disagreeing with "new rows" is the worst failure this
 * migration could produce. These functions choose WHICH row to project; the
 * database decides what it becomes.
 */

/** Ids are minted only for custodial holdings — see `mintEarnPositionForProviderWallet`. */
export function generateEarnPositionId(): string {
  return `earn_position_${crypto.randomUUID()}`;
}

export interface EarnPositionRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  provider: string;
  kind: EarnExecutionModel;
  /** vault_direct only. */
  custody_wallet_id: string | null;
  /** vault_direct only — the vault's on-chain address. */
  vault_address: string | null;
  share_mint: string | null;
  token_mint: string | null;
  /** custodial only — the program wallet this holding is reached through. */
  provider_wallet_id: string | null;
  label: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  closed_at: string | null;
}

export interface EarnMovementRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  provider: string;
  execution_model: EarnExecutionModel;
  direction: EarnMovementDirection;
  position_id: string;
  status: EarnMovementStatus;
  failure_reason: string | null;
  /** Optimistic chain commitment (vault only); not settlement. */
  confirmed_at: string | null;
  /** Success-terminal: finalization (vault) or provider completion (custodial). */
  settled_at: string | null;
  /** `usd`, or the token mint — the unit every amount below is denominated in. */
  denomination: string;
  amount_requested: string;
  amount_settled: string | null;
  fee_amount: string | null;
  /** Share units, never comparable to the amount columns. */
  min_shares_out: string | null;
  shares_out: string | null;
  /** Legacy custodial payout stablecoin symbol; NOT the asset identity. */
  payout_token: string | null;
  custody_wallet_id: string | null;
  vault_address: string | null;
  source_address: string | null;
  destination_address: string | null;
  /** The provider's id for THIS movement; null while an intent is unresolved. */
  provider_reference: string | null;
  signature: string | null;
  signed_transaction: string | null;
  /** NUMERIC in Postgres, read back as a string so uint64 round-trips exactly. */
  last_valid_block_height: string | null;
  request_id: string;
  idempotency_fingerprint: string;
  provider_data: Record<string, unknown>;
  created_by: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Columns a re-projection must not clobber.
 *
 * `finalized` is the one status the unified ledger can hold that no legacy table
 * can express, so a legacy row can never be the authority on a row that already
 * reached it. Without this guard a later legacy write would not merely regress
 * the status — it would re-project `settled_at` as NULL and violate 0062's
 * settlement biconditional, failing the legacy write itself.
 */
const NOT_ALREADY_FINALIZED = `WHERE earn_movements.status <> 'finalized'`;

/**
 * Assert that a legacy row actually projects, BEFORE trying to mirror it.
 *
 * `INSERT ... SELECT ... FROM <view> WHERE id = ?` inserts zero rows and
 * SUCCEEDS when the view yields nothing — so an unprojectable row would be
 * silently dropped from the ledger rather than failing. For a money movement
 * that is the worst possible outcome, and it is reachable: the movement views
 * join INNER to a holding, so a program wallet or vault claim without one
 * produces exactly that empty result.
 *
 * The row count of the mirror itself cannot stand in for this check, because
 * zero rows is also the legitimate answer when the finalization guard above
 * declines an update.
 */
async function requireProjectableRow(
  db: AppDb,
  view: string,
  keyColumn: string,
  key: string,
  remedy: string
): Promise<void> {
  const projected = await db
    .prepare(`SELECT 1 AS projectable FROM ${view} WHERE ${keyColumn} = ?`)
    .bind(key)
    .first<{ projectable: number }>();
  if (!projected) {
    throw new Error(`Earn ledger cannot project ${keyColumn}=${key} through ${view}: ${remedy}`);
  }
}

/**
 * Mirror one signed vault movement (`earn_vault_movements`) into the ledger.
 *
 * Call inside the same transaction as the legacy write. The projected row keeps
 * the legacy id, so this is an upsert rather than an insert: the deposit path
 * projects a fresh `requested` row, and every later guarded transition
 * re-projects the same id with its new state.
 */
export async function projectEarnMovementFromVaultMovement(
  db: AppDb,
  movementId: string
): Promise<void> {
  await requireProjectableRow(
    db,
    "earn_projected_movement_from_vault_movement",
    "id",
    movementId,
    "its vault holding is missing from earn_positions"
  );
  await db
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id, status,
         failure_reason, confirmed_at,
         denomination, amount_requested, amount_settled, min_shares_out, shares_out,
         custody_wallet_id, vault_address, source_address, destination_address,
         signature, signed_transaction, last_valid_block_height,
         request_id, idempotency_fingerprint,
         created_by, initiated_by_key_id, created_at, updated_at
       )
       SELECT
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id, status,
         failure_reason, confirmed_at,
         denomination, amount_requested, amount_settled, min_shares_out, shares_out,
         custody_wallet_id, vault_address, source_address, destination_address,
         signature, signed_transaction, last_valid_block_height,
         request_id, idempotency_fingerprint,
         created_by, initiated_by_key_id, created_at, updated_at
       FROM earn_projected_movement_from_vault_movement
       WHERE id = ?
       ON CONFLICT (id) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         project_id = EXCLUDED.project_id,
         environment = EXCLUDED.environment,
         provider = EXCLUDED.provider,
         execution_model = EXCLUDED.execution_model,
         direction = EXCLUDED.direction,
         position_id = EXCLUDED.position_id,
         status = EXCLUDED.status,
         failure_reason = EXCLUDED.failure_reason,
         confirmed_at = EXCLUDED.confirmed_at,
         denomination = EXCLUDED.denomination,
         amount_requested = EXCLUDED.amount_requested,
         amount_settled = EXCLUDED.amount_settled,
         min_shares_out = EXCLUDED.min_shares_out,
         shares_out = EXCLUDED.shares_out,
         custody_wallet_id = EXCLUDED.custody_wallet_id,
         vault_address = EXCLUDED.vault_address,
         source_address = EXCLUDED.source_address,
         destination_address = EXCLUDED.destination_address,
         signature = EXCLUDED.signature,
         signed_transaction = EXCLUDED.signed_transaction,
         last_valid_block_height = EXCLUDED.last_valid_block_height,
         request_id = EXCLUDED.request_id,
         idempotency_fingerprint = EXCLUDED.idempotency_fingerprint,
         created_by = EXCLUDED.created_by,
         initiated_by_key_id = EXCLUDED.initiated_by_key_id,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at
       ${NOT_ALREADY_FINALIZED}`
    )
    .bind(movementId)
    .run();
}

/**
 * Mirror one withdrawal intent/observation (`earn_program_withdrawals`) into the
 * ledger. Call inside the same transaction as the legacy write.
 *
 * Requires the program's custodial holding to exist — 0064 mints one for every
 * existing program wallet and `mintEarnPositionForProviderWallet` covers new
 * ones, so a missing holding fails loudly here rather than silently skipping a
 * money movement.
 */
export async function projectEarnMovementFromWithdrawal(
  db: AppDb,
  withdrawalId: string
): Promise<void> {
  await requireProjectableRow(
    db,
    "earn_projected_movement_from_withdrawal",
    "id",
    withdrawalId,
    "its program wallet has no custodial holding in earn_positions"
  );
  await db
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id, status,
         failure_reason, settled_at,
         denomination, amount_requested, amount_settled, fee_amount, payout_token,
         destination_address, provider_reference,
         request_id, idempotency_fingerprint, provider_data,
         created_by, initiated_by_key_id, created_at, updated_at
       )
       SELECT
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id, status,
         failure_reason, settled_at,
         denomination, amount_requested, amount_settled, fee_amount, payout_token,
         destination_address, provider_reference,
         request_id, idempotency_fingerprint, provider_data,
         created_by, initiated_by_key_id, created_at, updated_at
       FROM earn_projected_movement_from_withdrawal
       WHERE id = ?
       ON CONFLICT (id) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         project_id = EXCLUDED.project_id,
         environment = EXCLUDED.environment,
         provider = EXCLUDED.provider,
         execution_model = EXCLUDED.execution_model,
         direction = EXCLUDED.direction,
         position_id = EXCLUDED.position_id,
         status = EXCLUDED.status,
         failure_reason = EXCLUDED.failure_reason,
         settled_at = EXCLUDED.settled_at,
         denomination = EXCLUDED.denomination,
         amount_requested = EXCLUDED.amount_requested,
         amount_settled = EXCLUDED.amount_settled,
         fee_amount = EXCLUDED.fee_amount,
         payout_token = EXCLUDED.payout_token,
         destination_address = EXCLUDED.destination_address,
         provider_reference = EXCLUDED.provider_reference,
         request_id = EXCLUDED.request_id,
         idempotency_fingerprint = EXCLUDED.idempotency_fingerprint,
         provider_data = EXCLUDED.provider_data,
         created_by = EXCLUDED.created_by,
         initiated_by_key_id = EXCLUDED.initiated_by_key_id,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at
       ${NOT_ALREADY_FINALIZED}`
    )
    .bind(withdrawalId)
    .run();
}

/**
 * Mirror one vault holding (`earn_vault_positions`) into `earn_positions`.
 *
 * Must run before the movement that references it: the ledger's tenancy and
 * exact-claim foreign keys both point at this row.
 */
export async function projectEarnPositionFromVaultPosition(
  db: AppDb,
  positionId: string
): Promise<void> {
  await requireProjectableRow(
    db,
    "earn_projected_position_from_vault_position",
    "id",
    positionId,
    "no such row in earn_vault_positions"
  );
  await db
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         custody_wallet_id, vault_address, share_mint, token_mint,
         label, created_by, created_at, updated_at, activated_at, closed_at
       )
       SELECT
         id, organization_id, project_id, environment, provider, kind,
         custody_wallet_id, vault_address, share_mint, token_mint,
         label, created_by, created_at, updated_at, activated_at, closed_at
       FROM earn_projected_position_from_vault_position
       WHERE id = ?
       ON CONFLICT (id) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         project_id = EXCLUDED.project_id,
         environment = EXCLUDED.environment,
         provider = EXCLUDED.provider,
         kind = EXCLUDED.kind,
         custody_wallet_id = EXCLUDED.custody_wallet_id,
         vault_address = EXCLUDED.vault_address,
         share_mint = EXCLUDED.share_mint,
         token_mint = EXCLUDED.token_mint,
         label = EXCLUDED.label,
         created_by = EXCLUDED.created_by,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         activated_at = EXCLUDED.activated_at,
         closed_at = EXCLUDED.closed_at`
    )
    .bind(positionId)
    .run();
}

/**
 * Create the custodial holding for a newly linked program wallet.
 *
 * The only projection that mints an id instead of preserving one: a program
 * wallet never had a holding row to carry an id from. Insert-only and guarded on
 * the wallet, so linking is idempotent and an existing holding — including one
 * 0064 already minted — is left exactly as it is.
 */
export async function mintEarnPositionForProviderWallet(
  db: AppDb,
  providerWalletId: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         provider_wallet_id, label, created_by, created_at, updated_at, activated_at
       )
       SELECT
         ?,
         projected.organization_id,
         projected.project_id,
         projected.environment,
         projected.provider,
         projected.kind,
         projected.provider_wallet_id,
         projected.label,
         projected.created_by,
         projected.created_at,
         projected.updated_at,
         projected.activated_at
       FROM earn_projected_position_from_provider_wallet projected
       WHERE projected.provider_wallet_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM earn_positions existing
           WHERE existing.provider_wallet_id = projected.provider_wallet_id
             AND existing.kind = 'custodial'
         )
       ON CONFLICT DO NOTHING`
    )
    .bind(generateEarnPositionId(), providerWalletId)
    .run();

  // The invariant is the POST-condition, not the insert: after this call the
  // program has a custodial holding, whether this call minted it or found one.
  // Asserting it here is what stops a program from existing that the ledger
  // cannot record a withdrawal against — a zero-row insert is silent otherwise.
  const held = await db
    .prepare(
      `SELECT 1 AS held FROM earn_positions
       WHERE provider_wallet_id = ? AND kind = 'custodial'`
    )
    .bind(providerWalletId)
    .first<{ held: number }>();
  if (!held) {
    throw new Error(
      `Earn ledger could not open a custodial holding for program wallet ${providerWalletId}`
    );
  }
}

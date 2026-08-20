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
 * That repair rule covers HOLDINGS as well as movements, and deliberately: a
 * movement whose holding is missing cannot be projected at all, so every write
 * path projects the holding first, and the custodial path opens one if none
 * exists. A missing holding must never be able to fail a money write — on the
 * observation path the mirror shares its transaction with the legacy write, so
 * throwing would roll back the record of a payout the provider already made.
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

/**
 * Prefix of a minted holding id.
 *
 * Exported because migration 0064 mints the same ids in SQL and cannot import
 * this: a conformance test asserts the literal in that file matches this
 * constant, so the two mints cannot come to disagree on the id shape.
 */
export const EARN_POSITION_ID_PREFIX = "earn_position_";

/** Ids are minted only for custodial holdings — see `mintEarnPositionForProviderWallet`. */
export function generateEarnPositionId(): string {
  return `${EARN_POSITION_ID_PREFIX}${crypto.randomUUID()}`;
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
 * Does this legacy row actually project?
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
async function isProjectable(
  db: AppDb,
  view: string,
  keyColumn: string,
  key: string
): Promise<boolean> {
  const projected = await db
    .prepare(`SELECT 1 AS projectable FROM ${view} WHERE ${keyColumn} = ?`)
    .bind(key)
    .first<{ projectable: number }>();
  return Boolean(projected);
}

/** `isProjectable`, as the precondition it guards. */
async function requireProjectableRow(
  db: AppDb,
  view: string,
  keyColumn: string,
  key: string,
  remedy: string
): Promise<void> {
  if (!(await isProjectable(db, view, keyColumn, key))) {
    throw new Error(`Earn ledger cannot project ${keyColumn}=${key} through ${view}: ${remedy}`);
  }
}

/**
 * One projection, described once.
 *
 * The column list is the part of a projection that drifts SILENTLY: a column
 * added to a view but missed in one of the three clauses that carry it (the
 * INSERT list, the SELECT list, the `DO UPDATE SET` assignments) is written on
 * the first mirror and then never refreshed on any later transition, with every
 * test still green. So the three clauses are GENERATED from this array rather
 * than maintained beside each other, which makes that particular disagreement
 * unrepresentable — and `columns` is pinned against the view's own output
 * columns by a conformance test, which closes the remaining direction.
 */
interface EarnProjectionSpec {
  /** The unified table the projection writes. */
  table: string;
  /** 0063's view — the single definition of what a legacy row becomes. */
  view: string;
  /** Every column carried, in one order, used by all three clauses. */
  columns: readonly string[];
}

/**
 * The id-preserving projections, keyed by the legacy row they mirror.
 *
 * Exported for the conformance test only. `earn_projected_position_from_provider_wallet`
 * is deliberately absent: it MINTS an id rather than preserving one and is keyed
 * on `provider_wallet_id`, so it is not an `ON CONFLICT (id)` upsert.
 */
export const EARN_PROJECTION_SPECS = {
  vaultMovement: {
    table: "earn_movements",
    view: "earn_projected_movement_from_vault_movement",
    columns: [
      "id",
      "organization_id",
      "project_id",
      "environment",
      "provider",
      "execution_model",
      "direction",
      "position_id",
      "status",
      "failure_reason",
      "confirmed_at",
      "denomination",
      "amount_requested",
      "amount_settled",
      "min_shares_out",
      "shares_out",
      "custody_wallet_id",
      "vault_address",
      "source_address",
      "destination_address",
      "signature",
      "signed_transaction",
      "last_valid_block_height",
      "request_id",
      "idempotency_fingerprint",
      "created_by",
      "initiated_by_key_id",
      "created_at",
      "updated_at",
    ],
  },
  withdrawal: {
    table: "earn_movements",
    view: "earn_projected_movement_from_withdrawal",
    columns: [
      "id",
      "organization_id",
      "project_id",
      "environment",
      "provider",
      "execution_model",
      "direction",
      "position_id",
      "status",
      "failure_reason",
      "settled_at",
      "denomination",
      "amount_requested",
      "amount_settled",
      "fee_amount",
      "payout_token",
      "destination_address",
      "provider_reference",
      "request_id",
      "idempotency_fingerprint",
      "provider_data",
      "created_by",
      "initiated_by_key_id",
      "created_at",
      "updated_at",
    ],
  },
  vaultPosition: {
    table: "earn_positions",
    view: "earn_projected_position_from_vault_position",
    columns: [
      "id",
      "organization_id",
      "project_id",
      "environment",
      "provider",
      "kind",
      "custody_wallet_id",
      "vault_address",
      "share_mint",
      "token_mint",
      "label",
      "created_by",
      "created_at",
      "updated_at",
      "activated_at",
      "closed_at",
    ],
  },
} as const satisfies Record<string, EarnProjectionSpec>;

/**
 * `INSERT ... SELECT ... FROM <view> WHERE id = ? ON CONFLICT (id) DO UPDATE`,
 * with all three column clauses generated from `spec.columns`.
 *
 * Re-projects the WHOLE row rather than patching what changed, because the
 * invariant is "a unified row IS the projection of its legacy row". `id` is
 * excluded from the assignments: it is the conflict key and is by definition
 * already equal.
 */
function projectByIdSql(spec: EarnProjectionSpec, guard = ""): string {
  const columns = spec.columns.join(", ");
  const assignments = spec.columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(", ");
  return `INSERT INTO ${spec.table} (${columns})
     SELECT ${columns} FROM ${spec.view} WHERE id = ?
     ON CONFLICT (id) DO UPDATE SET ${assignments}
     ${guard}`;
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
    EARN_PROJECTION_SPECS.vaultMovement.view,
    "id",
    movementId,
    "its vault holding is missing from earn_positions"
  );
  await db
    .prepare(projectByIdSql(EARN_PROJECTION_SPECS.vaultMovement, NOT_ALREADY_FINALIZED))
    .bind(movementId)
    .run();
}

/**
 * Mirror one withdrawal intent/observation (`earn_program_withdrawals`) into the
 * ledger. Call inside the same transaction as the legacy write.
 *
 * Needs the program's custodial holding, and OPENS one if the ledger has none.
 * 0064 mints a holding for every program wallet that already exists and
 * `insertProviderWallet` mints one for each new link, so healing here is the
 * path for a program those two could not reach — see the comment below for why
 * failing instead was not survivable.
 */
export async function projectEarnMovementFromWithdrawal(
  db: AppDb,
  withdrawalId: string
): Promise<void> {
  const spec = EARN_PROJECTION_SPECS.withdrawal;
  if (!(await isProjectable(db, spec.view, "id", withdrawalId))) {
    // The program has no custodial holding yet. Opening one here — rather than
    // failing — is what keeps `insertProviderWallet` from being a PRIVILEGED
    // creator whose absence breaks money movement: a program linked by a
    // revision that predates the ledger, or during a rollout or rollback
    // window, otherwise had no holding permanently, and every withdrawal
    // against it would fail closed for good.
    //
    // That failure was not merely an outage. On the observation path the mirror
    // shares its transaction with the status write, so a throw here rolled back
    // the `provider_reference` stamp for a withdrawal the provider had already
    // PAID — and a movement with no reference is the one row nothing can heal,
    // because every observation lookup resolves through it. Healing is the same
    // "repaired by the next write that touches it" rule the rest of this module
    // follows, applied to the holding instead of the movement.
    await healCustodialHoldingForWithdrawal(db, withdrawalId);
    await requireProjectableRow(
      db,
      spec.view,
      "id",
      withdrawalId,
      "its program wallet has no custodial holding in earn_positions and one could not be opened"
    );
  }
  await db.prepare(projectByIdSql(spec, NOT_ALREADY_FINALIZED)).bind(withdrawalId).run();
}

/**
 * Open the custodial holding for the program a withdrawal was made through.
 *
 * Resolves the program wallet from the withdrawal rather than taking it as an
 * argument, so every caller of the projection heals identically and none has to
 * know the rule. A withdrawal row that does not exist is left to the projection
 * assertion to report — this is a repair, not a validation.
 */
async function healCustodialHoldingForWithdrawal(db: AppDb, withdrawalId: string): Promise<void> {
  const owner = await db
    .prepare(`SELECT wallet_id FROM earn_program_withdrawals WHERE id = ?`)
    .bind(withdrawalId)
    .first<{ wallet_id: string }>();
  if (!owner) return;
  await mintEarnPositionForProviderWallet(db, owner.wallet_id);
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
    EARN_PROJECTION_SPECS.vaultPosition.view,
    "id",
    positionId,
    "no such row in earn_vault_positions"
  );
  await db.prepare(projectByIdSql(EARN_PROJECTION_SPECS.vaultPosition)).bind(positionId).run();
}

/**
 * Repair a vault movement the ledger is missing, without rewriting one it has.
 *
 * For the REPLAY paths, whose job is repair rather than refresh: a replay wrote
 * no legacy row, so there is by definition nothing new to project — but it may
 * be the first write path to touch a movement an older revision recorded
 * without mirroring. Probing first keeps a replay from taking a row lock on the
 * very row its concurrent twin is writing, which is the ordinary shape of a
 * raced idempotent deposit.
 */
export async function ensureEarnMovementFromVaultMovement(
  db: AppDb,
  movementId: string
): Promise<void> {
  const mirrored = await db
    .prepare(`SELECT 1 AS mirrored FROM earn_movements WHERE id = ?`)
    .bind(movementId)
    .first<{ mirrored: number }>();
  if (mirrored) return;
  await projectEarnMovementFromVaultMovement(db, movementId);
}

/**
 * Make sure a vault movement's holding is in the ledger, WITHOUT rewriting it.
 *
 * The distinction from `projectEarnPositionFromVaultPosition` is about locks,
 * not tidiness. A movement transition that changes no holding state has nothing
 * to refresh, so re-projecting would take a row lock on the holding for no
 * reason — and two concurrent flows against the SAME holding (the ordinary
 * shape of a raced idempotent deposit: one request advancing to `submitted`
 * while its twin resolves the replay) would then deadlock against each other.
 * A probe takes no row lock, so the common case does not contend at all, and
 * the repair still happens on the one path that needs it.
 *
 * Use this wherever a holding must merely EXIST; use the projection itself
 * wherever the holding's own state may have changed — activation and closure,
 * which only a terminal transition performs.
 */
export async function ensureEarnPositionFromVaultPosition(
  db: AppDb,
  positionId: string
): Promise<void> {
  const held = await db
    .prepare(`SELECT 1 AS held FROM earn_positions WHERE id = ?`)
    .bind(positionId)
    .first<{ held: number }>();
  if (held) return;
  await projectEarnPositionFromVaultPosition(db, positionId);
}

/**
 * Create the custodial holding for a newly linked program wallet.
 *
 * The only projection that mints an id instead of preserving one: a program
 * wallet never had a holding row to carry an id from. Insert-only and guarded on
 * the wallet, so linking is idempotent and an existing holding — including one
 * 0064 already minted — is left exactly as it is.
 */
export const EARN_CUSTODIAL_MINT_COLUMNS = [
  "organization_id",
  "project_id",
  "environment",
  "provider",
  "kind",
  "provider_wallet_id",
  "label",
  "created_by",
  "created_at",
  "updated_at",
  "activated_at",
] as const;

export async function mintEarnPositionForProviderWallet(
  db: AppDb,
  providerWalletId: string
): Promise<void> {
  const copied = EARN_CUSTODIAL_MINT_COLUMNS.join(", ");
  const selected = EARN_CUSTODIAL_MINT_COLUMNS.map((column) => `projected.${column}`).join(", ");
  await db
    .prepare(
      `INSERT INTO earn_positions (id, ${copied})
       SELECT ?, ${selected}
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

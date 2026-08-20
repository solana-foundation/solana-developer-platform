import type {
  EarnExecutionModel,
  EarnMovementDirection,
  EarnMovementStatus,
  SdpEnvironment,
} from "@sdp/types";
import { EARN_MOVEMENT_TRANSITIONS } from "@sdp/types";
import type { AppDb } from "@/db";

/**
 * The unified Earn movement ledger (PRO-1705, migrations 0062-0065).
 *
 * `earn_movements` is the single authoritative record of every Earn money
 * movement — both directions, both execution models — and `earn_positions` is
 * the single holdings table behind it. This module owns writing them.
 *
 * ── What this module is, during the transition ────────────────────────────
 * The legacy tables (`earn_program_withdrawals`, `earn_vault_movements`,
 * `earn_vault_positions`) are still the authoritative WRITERS, and every read
 * below serves from the unified tables. This module MIRRORS each legacy write
 * into the unified shape, in the SAME transaction, so what the reads serve is
 * never behind what was written. The invariant is exactly:
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

/**
 * ── Reads ──────────────────────────────────────────────────────────────────
 *
 * Every Earn read serves from the unified tables. The wire contracts are
 * unchanged: ids were preserved by the projection, so a movement is still found
 * by the id a caller already holds, and both paging styles the two families
 * published are kept as they were (offset+total for withdrawal history, keyset
 * for vault deposits and holdings) rather than harmonised behind the callers'
 * backs.
 *
 * Scoping is preserved statement-for-statement from the legacy queries, because
 * these are the rules that decide who may see whose money. Where a rule was
 * enforced in SQL it stays in SQL — moving one into a handler would make it
 * skippable by the next caller.
 */

export interface EarnMovementCursor {
  createdAt: string;
  id: string;
}

export interface EarnMovementsRepository {
  /**
   * One movement by id, organization-scoped in the QUERY (BOLA): a caller who
   * may not see a movement must not be able to tell it exists.
   */
  getMovementById(params: {
    movementId: string;
    organizationId: string;
  }): Promise<EarnMovementRow | null>;
  /** Vault replay lookup — ORG-scoped, matching 0059's anchor. */
  findVaultMovementByRequestId(params: {
    organizationId: string;
    requestId: string;
  }): Promise<EarnMovementRow | null>;
  /** Custodial replay lookup — HOLDING-scoped, matching 0055's wallet anchor. */
  findCustodialMovementByRequestId(params: {
    organizationId: string;
    providerWalletId: string;
    requestId: string;
  }): Promise<EarnMovementRow | null>;
  /** Observation lookup — global index; callers assert the org after the fetch. */
  findMovementByProviderReference(params: {
    provider: string;
    providerReference: string;
  }): Promise<EarnMovementRow | null>;
  /** One workspace's recorded vault DEPOSITS, newest first, as a keyset page. */
  listVaultDeposits(params: {
    organizationId: string;
    environment: SdpEnvironment;
    projectId: string;
    custodyWalletIds: readonly string[];
    limit: number;
    before: EarnMovementCursor | null;
    settled?: boolean;
  }): Promise<{ rows: EarnMovementRow[]; hasMore: boolean }>;
  /** One program's withdrawal history, offset-paged with a total. */
  listCustodialMovements(params: {
    organizationId: string;
    providerWalletId: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: EarnMovementRow[]; total: number }>;
  getPositionById(params: {
    organizationId: string;
    environment: SdpEnvironment;
    positionId: string;
  }): Promise<EarnPositionRow | null>;
  /** Vault holdings with live movement evidence, newest first, as a keyset page. */
  listVaultPositions(params: {
    organizationId: string;
    environment: SdpEnvironment;
    custodyWalletIds: readonly string[];
    limit: number;
    before: EarnMovementCursor | null;
  }): Promise<{ rows: EarnPositionRow[]; hasMore: boolean }>;
  /**
   * The cross-provider movement feed: one chronological history spanning both
   * execution models, which is what neither legacy table could serve alone.
   *
   * Visibility is the UNION of what the two per-family reads already grant, and
   * not a wider grant dressed up as a new endpoint — vault rows stay
   * project-and-wallet scoped, custodial rows stay program scoped (every project
   * in an environment reaches every program). A caller sees exactly the rows the
   * existing endpoints would have shown it, in one list.
   */
  listMovements(params: {
    organizationId: string;
    environment: SdpEnvironment;
    projectId: string;
    /** Wallet-binding scope for vault rows; empty means no vault row is visible. */
    custodyWalletIds: readonly string[];
    limit: number;
    before: EarnMovementCursor | null;
    direction?: EarnMovementDirection;
    status?: string;
    provider?: string;
    positionId?: string;
    sourceAddress?: string;
    destinationAddress?: string;
  }): Promise<{ rows: EarnMovementRow[]; hasMore: boolean }>;
  /** Atomically select a fair, bounded batch and rotate its attempt cursor; not a work lease. */
  claimUnsettledVaultMovements(limit: number): Promise<EarnMovementRow[]>;
  /**
   * Guarded CAS to `finalized` — irreversible chain settlement.
   *
   * The one transition written HERE and nowhere else, because `finalized` is the
   * one status no legacy table can express. Everything before it still flows
   * through the legacy writer and is mirrored, so this is not a second authority
   * over a movement: it is the only authority over a fact the old shape had no
   * word for. Returns null when the row was not in a finalizable state.
   */
  finalizeVaultMovement(input: {
    movementId: string;
    organizationId: string;
    settledAt: string;
  }): Promise<EarnMovementRow | null>;
}

/**
 * The legal source states for a transition, read from the shared matrix rather
 * than spelled again here — so the guard cannot drift from the vocabulary it is
 * supposed to enforce.
 */
function allowedSourceStatuses(model: EarnExecutionModel, toStatus: string): readonly string[] {
  const matrix: Record<string, readonly string[]> = EARN_MOVEMENT_TRANSITIONS[model];
  const sources = matrix[toStatus];
  if (!sources || sources.length === 0) {
    throw new Error(`Illegal earn movement transition: ${model} -> ${toStatus}`);
  }
  return sources;
}

/**
 * The statuses a CLIENT of the legacy wire sees as final.
 *
 * `confirmed` is in it, and that is deliberate for as long as the legacy
 * vault-deposit DTO is served: that vocabulary has no `finalized`, so a client
 * reads chain commitment as the end of the story, and `?settled=` must keep
 * answering the question the client is actually asking. The ledger's own terminal
 * set (`EARN_TERMINAL_MOVEMENT_STATUSES.vault_direct`) is narrower, and becomes
 * the filter when a caller reads the unified vocabulary directly.
 */
const WIRE_SETTLED_VAULT_STATUSES = ["confirmed", "finalized", "failed"] as const;

function mapMovementRow(row: Record<string, unknown>): EarnMovementRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string | null,
    environment: row.environment as SdpEnvironment,
    provider: row.provider as string,
    execution_model: row.execution_model as EarnExecutionModel,
    direction: row.direction as EarnMovementDirection,
    position_id: row.position_id as string,
    status: row.status as EarnMovementStatus,
    failure_reason: row.failure_reason as string | null,
    confirmed_at: row.confirmed_at as string | null,
    settled_at: row.settled_at as string | null,
    denomination: row.denomination as string,
    amount_requested: row.amount_requested as string,
    amount_settled: row.amount_settled as string | null,
    fee_amount: row.fee_amount as string | null,
    min_shares_out: row.min_shares_out as string | null,
    shares_out: row.shares_out as string | null,
    payout_token: row.payout_token as string | null,
    custody_wallet_id: row.custody_wallet_id as string | null,
    vault_address: row.vault_address as string | null,
    source_address: row.source_address as string | null,
    destination_address: row.destination_address as string | null,
    provider_reference: row.provider_reference as string | null,
    signature: row.signature as string | null,
    signed_transaction: row.signed_transaction as string | null,
    last_valid_block_height: row.last_valid_block_height as string | null,
    request_id: row.request_id as string,
    idempotency_fingerprint: row.idempotency_fingerprint as string,
    provider_data: (row.provider_data ?? {}) as Record<string, unknown>,
    created_by: row.created_by as string | null,
    initiated_by_key_id: row.initiated_by_key_id as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPostgresEarnMovementsRepository(db: AppDb): EarnMovementsRepository {
  return {
    async getMovementById(params) {
      const row = await db
        .prepare(`SELECT * FROM earn_movements WHERE id = ? AND organization_id = ?`)
        .bind(params.movementId, params.organizationId)
        .first<Record<string, unknown>>();
      return row ? mapMovementRow(row) : null;
    },

    async findVaultMovementByRequestId(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_movements
             WHERE organization_id = ?
               AND request_id = ?
               AND execution_model = 'vault_direct'`
        )
        .bind(params.organizationId, params.requestId)
        .first<Record<string, unknown>>();
      return row ? mapMovementRow(row) : null;
    },

    async findCustodialMovementByRequestId(params) {
      // Anchored on the HOLDING, which is 1:1 with the program wallet, so sibling
      // projects sharing that program resolve the same replay row — 0055's rule.
      const row = await db
        .prepare(
          `SELECT movement.* FROM earn_movements movement
             INNER JOIN earn_positions position
               ON position.id = movement.position_id
              AND position.kind = 'custodial'
             WHERE movement.organization_id = ?
               AND position.provider_wallet_id = ?
               AND movement.request_id = ?
               AND movement.execution_model = 'custodial'`
        )
        .bind(params.organizationId, params.providerWalletId, params.requestId)
        .first<Record<string, unknown>>();
      return row ? mapMovementRow(row) : null;
    },

    async findMovementByProviderReference(params) {
      const row = await db
        .prepare(`SELECT * FROM earn_movements WHERE provider = ? AND provider_reference = ?`)
        .bind(params.provider, params.providerReference)
        .first<Record<string, unknown>>();
      return row ? mapMovementRow(row) : null;
    },

    async listVaultDeposits(params) {
      if (params.custodyWalletIds.length === 0) {
        throw new Error("listVaultDeposits requires at least one project-scoped custody wallet id");
      }
      const beforeClause = params.before ? "AND (created_at, id) < (?, ?)" : "";
      const beforeValues = params.before ? [params.before.createdAt, params.before.id] : [];
      const settledClause =
        params.settled === undefined
          ? ""
          : params.settled
            ? "AND status = ANY (?::text[])"
            : "AND NOT (status = ANY (?::text[]))";
      const settledValues = params.settled === undefined ? [] : [[...WIRE_SETTLED_VAULT_STATUSES]];
      const result = await db
        .prepare(
          // An EXACT project match. `project_id` is nullable only through
          // ON DELETE SET NULL, so a null means the project was deleted — and
          // accepting it here would expose that project's deposits to every
          // sibling project sharing an organization-level custody wallet.
          `SELECT * FROM earn_movements
             WHERE organization_id = ?
               AND environment = ?
               AND execution_model = 'vault_direct'
               AND direction = 'deposit'
               AND custody_wallet_id = ANY (?::text[])
               AND project_id = ?
               ${settledClause}
               ${beforeClause}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
        )
        .bind(
          params.organizationId,
          params.environment,
          params.custodyWalletIds,
          params.projectId,
          ...settledValues,
          ...beforeValues,
          params.limit + 1
        )
        .all<Record<string, unknown>>();
      const rows = (result.results ?? []).map(mapMovementRow);
      return { rows: rows.slice(0, params.limit), hasMore: rows.length > params.limit };
    },

    async listCustodialMovements(params) {
      // Program-scoped, not (org, project): every project in the environment
      // reaches the same programs, and since PRO-1670 an organization may hold
      // several — so the program is what joins sibling projects' history while
      // keeping a sibling PROGRAM's payouts out. One program = one history.
      const conditions = [
        "movement.organization_id = ?",
        "position.provider_wallet_id = ?",
        "movement.execution_model = 'custodial'",
      ];
      const bindings: unknown[] = [params.organizationId, params.providerWalletId];
      const where = conditions.join(" AND ");
      const from = `FROM earn_movements movement
             INNER JOIN earn_positions position
               ON position.id = movement.position_id
              AND position.kind = 'custodial'`;

      const [page, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT movement.* ${from}
               WHERE ${where}
               ORDER BY movement.created_at DESC, movement.id DESC
               LIMIT ? OFFSET ?`
          )
          .bind(...bindings, params.limit, params.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(`SELECT COUNT(*)::int AS total ${from} WHERE ${where}`)
          .bind(...bindings)
          .first<{ total: number }>(),
      ]);

      return {
        rows: (page.results ?? []).map(mapMovementRow),
        total: countRow?.total ?? 0,
      };
    },

    async getPositionById(params) {
      return db
        .prepare(
          `SELECT * FROM earn_positions
             WHERE id = ? AND organization_id = ? AND environment = ?`
        )
        .bind(params.positionId, params.organizationId, params.environment)
        .first<EarnPositionRow>();
    },

    async listVaultPositions(params) {
      if (params.custodyWalletIds.length === 0) {
        throw new Error(
          "listVaultPositions requires at least one project-scoped custody wallet id"
        );
      }
      const beforeClause = params.before ? "AND (created_at, id) < (?, ?)" : "";
      const beforeValues = params.before ? [params.before.createdAt, params.before.id] : [];
      const result = await db
        .prepare(
          `SELECT * FROM earn_positions
             WHERE organization_id = ?
               AND environment = ?
               AND kind = 'vault_direct'
               AND activated_at IS NOT NULL
               AND (
                 closed_at IS NULL
                 OR EXISTS (
                   SELECT 1
                   FROM earn_movements reentry
                   WHERE reentry.position_id = earn_positions.id
                     AND reentry.direction = 'deposit'
                     AND reentry.status IN ('requested', 'submitted')
                 )
               )
               AND custody_wallet_id = ANY (?::text[])
               AND EXISTS (
                 SELECT 1
                 FROM earn_movements movement
                 WHERE movement.position_id = earn_positions.id
                   AND movement.status IN ('requested', 'submitted', 'confirmed', 'finalized')
               )
               ${beforeClause}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
        )
        .bind(
          params.organizationId,
          params.environment,
          params.custodyWalletIds,
          ...beforeValues,
          params.limit + 1
        )
        .all<EarnPositionRow>();
      const rows = result.results ?? [];
      return { rows: rows.slice(0, params.limit), hasMore: rows.length > params.limit };
    },

    async listMovements(params) {
      const conditions = ["organization_id = ?", "environment = ?"];
      const bindings: unknown[] = [params.organizationId, params.environment];

      // The visibility union, spelled in SQL so no caller can skip half of it.
      // A vault row needs BOTH the exact project and an in-scope signing wallet;
      // a custodial row is reachable by every project in the environment, which
      // is how `/programs/:id/withdrawals` has always behaved.
      if (params.custodyWalletIds.length > 0) {
        conditions.push(
          `(
             execution_model = 'custodial'
             OR (
               project_id = ?
               AND custody_wallet_id = ANY (?::text[])
             )
           )`
        );
        bindings.push(params.projectId, params.custodyWalletIds);
      } else {
        conditions.push("execution_model = 'custodial'");
      }

      for (const [column, value] of [
        ["direction", params.direction],
        ["status", params.status],
        ["provider", params.provider],
        ["position_id", params.positionId],
        ["source_address", params.sourceAddress],
        ["destination_address", params.destinationAddress],
      ] as const) {
        if (value !== undefined) {
          conditions.push(`${column} = ?`);
          bindings.push(value);
        }
      }

      if (params.before) {
        conditions.push("(created_at, id) < (?, ?)");
        bindings.push(params.before.createdAt, params.before.id);
      }

      const result = await db
        .prepare(
          `SELECT * FROM earn_movements
             WHERE ${conditions.join(" AND ")}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
        )
        .bind(...bindings, params.limit + 1)
        .all<Record<string, unknown>>();
      const rows = (result.results ?? []).map(mapMovementRow);
      return { rows: rows.slice(0, params.limit), hasMore: rows.length > params.limit };
    },

    async claimUnsettledVaultMovements(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
        throw new Error("claimUnsettledVaultMovements limit must be an integer from 1 to 256");
      }
      // `confirmed` is IN the queue: the sweep's job no longer ends at chain
      // commitment now that finalization is the terminal state. `requested` is in
      // it because a broadcast timeout or crash leaves a row unsubmitted WITH a
      // signature, which is precisely the ambiguous case reconciliation is for.
      //
      // Blockhash-bound work gets most of the batch, but never all of it once the
      // caller can process at least two rows. A confirmed signature can fall out
      // of RPC history and remain confirmed forever, while a sustained stream of
      // requested/submitted rows can likewise keep finalization from being
      // recorded. Reserve one quarter (at least one row) for confirmed work, then
      // fill any unused reservation from either side so the batch stays full.
      // Selection also advances an internal attempt cursor (not public
      // `updated_at`) so an RPC-null row rotates behind its peers instead of
      // monopolizing the same reserved slice forever. This is a fairness cursor,
      // not a lease held for the later RPC work.
      const confirmedQuota = limit > 1 ? Math.max(1, Math.floor(limit / 4)) : 0;
      const blockhashBoundQuota = limit - confirmedQuota;
      const result = await db
        .prepare(
          `WITH blockhash_bound AS MATERIALIZED (
             SELECT id FROM earn_movements
              WHERE execution_model = 'vault_direct'
                AND status IN ('requested', 'submitted')
              ORDER BY COALESCE(reconciliation_attempted_at, created_at) ASC,
                       created_at ASC,
                       id ASC
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           ), confirmed AS MATERIALIZED (
             SELECT id FROM earn_movements
              WHERE execution_model = 'vault_direct'
                AND status = 'confirmed'
              ORDER BY COALESCE(reconciliation_attempted_at, created_at) ASC,
                       created_at ASC,
                       id ASC
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           ), reserved AS MATERIALIZED (
             SELECT * FROM blockhash_bound
             UNION ALL
             SELECT * FROM confirmed
           ), overflow AS (
             SELECT movement.id
               FROM earn_movements movement
              WHERE movement.execution_model = 'vault_direct'
                AND movement.status IN ('requested', 'submitted', 'confirmed')
                AND NOT EXISTS (
                  SELECT 1 FROM reserved WHERE reserved.id = movement.id
                )
              ORDER BY (movement.status = 'confirmed') ASC,
                       COALESCE(movement.reconciliation_attempted_at, movement.created_at) ASC,
                       movement.created_at ASC,
                       movement.id ASC
              LIMIT GREATEST(0, ? - (SELECT COUNT(*) FROM reserved))
              FOR UPDATE OF movement SKIP LOCKED
           ), claimed AS (
             SELECT id FROM reserved
             UNION ALL
             SELECT id FROM overflow
           ), touched AS (
             UPDATE earn_movements movement
                SET reconciliation_attempted_at = sdp_iso_now()
               FROM claimed
              WHERE movement.id = claimed.id
             RETURNING movement.*
           )
           SELECT * FROM touched
           ORDER BY (status = 'confirmed') ASC, created_at ASC, id ASC`
        )
        .bind(blockhashBoundQuota, confirmedQuota, limit)
        .all<Record<string, unknown>>();
      return (result.results ?? []).map(mapMovementRow);
    },

    async finalizeVaultMovement(input) {
      const sources = allowedSourceStatuses("vault_direct", "finalized");
      const guards = sources.map(() => "?").join(", ");
      const row = await db
        .prepare(
          // `confirmed_at` is COALESCEd rather than assumed: a sweep whose FIRST
          // observation is already finalized never saw a separate commitment, and
          // 0062's confirmation biconditional requires the column to be set for
          // any finalized row. Stamping the moment we learned of it is the honest
          // reading — and leaving it null would fail the write outright.
          `UPDATE earn_movements
              SET status = 'finalized',
                  settled_at = ?,
                  confirmed_at = COALESCE(confirmed_at, ?),
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND organization_id = ?
              AND execution_model = 'vault_direct'
              AND status IN (${guards})
            RETURNING *`
        )
        .bind(input.settledAt, input.settledAt, input.movementId, input.organizationId, ...sources)
        .first<Record<string, unknown>>();
      return row ? mapMovementRow(row) : null;
    },
  };
}

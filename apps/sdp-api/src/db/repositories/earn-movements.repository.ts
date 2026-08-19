import type {
  EarnExecutionModel,
  EarnMovementDirection,
  EarnMovementStatus,
  SdpEnvironment,
} from "@sdp/types";
import { EARN_MOVEMENT_TRANSITIONS } from "@sdp/types";
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
  /** Global bounded outbox scan for the reconciliation worker. */
  listUnsettledVaultMovements(limit: number): Promise<EarnMovementRow[]>;
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

    async listUnsettledVaultMovements(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
        throw new Error("listUnsettledVaultMovements limit must be an integer from 1 to 256");
      }
      // `confirmed` is IN the queue: the sweep's job no longer ends at chain
      // commitment now that finalization is the terminal state. `requested` is in
      // it because a broadcast timeout or crash leaves a row unsubmitted WITH a
      // signature, which is precisely the ambiguous case reconciliation is for.
      //
      // Blockhash-bound work comes first. A confirmed signature can fall out of
      // RPC history and correctly remain confirmed forever; letting those rows
      // lead this bounded query would repeatedly consume the whole batch while a
      // newer requested/submitted transaction expires without reconciliation.
      const result = await db
        .prepare(
          `SELECT * FROM earn_movements
             WHERE execution_model = 'vault_direct'
               AND status IN ('requested', 'submitted', 'confirmed')
             ORDER BY (status = 'confirmed') ASC, created_at ASC, id ASC
             LIMIT ?`
        )
        .bind(limit)
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

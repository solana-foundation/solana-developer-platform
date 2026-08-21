import type {
  EarnExecutionModel,
  EarnMovementDirection,
  EarnMovementStatus,
  SdpEnvironment,
} from "@sdp/types";
import { EARN_MOVEMENT_TRANSITIONS } from "@sdp/types";
import { type AppDb, asTransactionalClient } from "@/db";
import { conflict } from "@/lib/errors";

/**
 * The unified Earn movement ledger (PRO-1705, migrations 0062-0065).
 *
 * `earn_movements` is the single authoritative record of every Earn money
 * movement — both directions, both execution models — and `earn_positions` is
 * the single holdings table behind it. This module owns writing them.
 *
 * This is the ONLY writer and the only reader. The mechanism-split tables it
 * replaced (`earn_program_withdrawals`, `earn_vault_movements`,
 * `earn_vault_positions`) no longer take writes, and a later migration drops
 * them along with the projection views that carried their history across.
 *
 * `earn_provider_wallets` is deliberately NOT among them: it models an ACCOUNT at
 * a provider — the custodial twin of `custody_wallets` — and an account is not a
 * holding. A custodial position is the link row between the two.
 */

/**
 * Prefix of a minted holding id.
 *
 * Exported because the backfill migrations mint the same ids in SQL and cannot
 * import this: a conformance test asserts the literal in 0064 matches this
 * constant, so the two mints cannot come to disagree on the id shape.
 */
export const EARN_POSITION_ID_PREFIX = "earn_position_";

export function generateEarnPositionId(): string {
  return `${EARN_POSITION_ID_PREFIX}${crypto.randomUUID()}`;
}

/**
 * One id space for every movement, both execution models.
 *
 * History keeps the ids the projection preserved (`earn_vault_movement_…`,
 * `earn_program_withdrawal_…`), so the table holds a mix for as long as those rows
 * live. That is why nothing may parse a movement id for its kind — read
 * `execution_model`.
 */
export function generateEarnMovementId(): string {
  return `earn_movement_${crypto.randomUUID()}`;
}

/**
 * Assert a prior movement under this idempotency key is THIS request's own replay
 * — same project AND same fingerprint — before it is returned as one.
 *
 * THIS FUNCTION IS THE RULE, and it is exported so every site that resolves a
 * replay enforces the same one. It kept re-appearing as a bug precisely because it
 * was re-implemented per site: the vault anchor is org-scoped and the server
 * fingerprint omits the project, so any site that forgets this check hands a
 * sibling project's movement back as the caller's own replay — answering the wrong
 * deposit, with its amount and its signature.
 *
 * A different project answers with the SAME conflict as a divergent fingerprint,
 * deliberately: the key really has been used by a different request, and a distinct
 * message would disclose that a sibling project holds it. A null `project_id`
 * (owner deleted) conflicts too — the key is genuinely burnt either way.
 */
export function assertMovementIsOwnReplay(
  movement: EarnMovementRow,
  request: { projectId: string; idempotencyFingerprint: string }
): void {
  if (
    movement.project_id !== request.projectId ||
    movement.idempotency_fingerprint !== request.idempotencyFingerprint
  ) {
    throw conflict("Idempotency key already used with different request payload");
  }
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

/** Internal signed-transaction outbox row beneath one vault withdrawal movement. */
export interface EarnVaultWithdrawalLegRow {
  movement_id: string;
  leg_index: number;
  shares: string;
  status: EarnMovementStatus;
  signature: string;
  signed_transaction: string;
  last_valid_block_height: string;
  failure_reason: string | null;
  confirmed_at: string | null;
  settled_at: string | null;
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
         ?, wallet.organization_id, wallet.project_id, wallet.environment,
         wallet.provider, 'custodial', wallet.id,
         -- earn_provider_wallets.label is nullable and earn_positions.label is
         -- not. The provider wallet ref is the honest fallback: it is what the
         -- provider console shows for an unlabelled program.
         COALESCE(wallet.label, wallet.provider_wallet_ref),
         wallet.created_by, wallet.created_at, wallet.updated_at,
         -- A custodial holding is live from the moment its program exists, unlike a
         -- vault claim, which is only activated by a durably recorded signed
         -- transaction.
         wallet.created_at
       FROM earn_provider_wallets wallet
       WHERE wallet.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM earn_positions existing
            WHERE existing.provider_wallet_id = wallet.id
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
  /**
   * One workspace's recorded vault movements of ONE direction, newest first, as
   * a keyset page. The direction is a required parameter rather than two copies
   * of this query: deposits and withdrawal legs share every scoping rule
   * (organization, environment, exact project, wallet binding), and a shared
   * builder is what keeps them from drifting apart.
   */
  listVaultMovements(params: {
    organizationId: string;
    environment: SdpEnvironment;
    projectId: string;
    custodyWalletIds: readonly string[];
    direction: EarnMovementDirection;
    limit: number;
    before: EarnMovementCursor | null;
    settled?: boolean;
  }): Promise<{ rows: EarnMovementRow[]; hasMore: boolean }>;
  /** Every internal transaction leg of one withdrawal, submission order. */
  listVaultWithdrawalLegs(params: {
    organizationId: string;
    movementId: string;
  }): Promise<EarnVaultWithdrawalLegRow[]>;
  /**
   * One leg by (group, index) — global like the provider-reference lookup, for
   * the reconciliation sweep's predecessor gate; callers already hold a row of
   * the same group, which is what scopes the question.
   */
  getVaultWithdrawalLegByIndex(params: {
    movementId: string;
    legIndex: number;
  }): Promise<EarnVaultWithdrawalLegRow | null>;
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
  /** Fairly claim unsettled child transactions for withdrawal reconciliation. */
  claimUnsettledVaultWithdrawalLegs(
    limit: number
  ): Promise<Array<{ movement: EarnMovementRow; leg: EarnVaultWithdrawalLegRow }>>;

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Atomically claim/refresh the vault holding, insert the signed movement, and
   * activate the holding. A divergent idempotency loser throws so the entire
   * claim rolls back; an identical loser returns the winning signed row.
   */
  createSignedVaultDepositIntent(input: CreateSignedVaultDepositIntentInput): Promise<{
    position: EarnPositionRow;
    movement: EarnMovementRow;
    replayed: boolean;
  }>;
  /**
   * Atomically record every signed leg of one vault withdrawal against an
   * EXISTING holding — record-before-broadcast for the whole group, so a crash
   * at any point leaves nothing on the wire that the ledger cannot reconcile
   * by signature. Never creates or activates a holding: an exit is only ever
   * asked of a position the organization already holds, and the movement
   * rows' composite FK onto that position is what refuses a claim whose vault
   * or wallet does not match. A divergent idempotency loser throws so the
   * whole group rolls back; an identical loser returns the winning group.
   */
  createSignedVaultWithdrawalIntent(input: CreateSignedVaultWithdrawalIntentInput): Promise<{
    position: EarnPositionRow;
    movement: EarnMovementRow;
    legs: EarnVaultWithdrawalLegRow[];
    replayed: boolean;
  }>;
  /**
   * Guarded CAS on a vault movement. Legal source states come from the shared
   * transition matrix, so terminal regression is unrepresentable rather than
   * merely discouraged, and a lost race returns null rather than an error.
   */
  advanceVaultMovement(input: AdvanceVaultMovementInput): Promise<EarnMovementRow | null>;
  /** Advance one withdrawal transaction and recompute its parent movement atomically. */
  advanceVaultWithdrawalLeg(input: AdvanceVaultWithdrawalLegInput): Promise<{
    movement: EarnMovementRow;
    leg: EarnVaultWithdrawalLegRow;
  } | null>;
  /**
   * Insert-at-intent for a custodial movement: the row exists before the provider
   * accepts. Always returns the row — a missing holding heals then retries, and a
   * missing program wallet throws rather than letting money move unrecorded.
   */
  createCustodialMovement(input: CreateCustodialMovementInput): Promise<EarnMovementRow>;
  /** Guarded CAS on a custodial movement, by row id or by provider reference. */
  updateCustodialMovementGuarded(
    input: UpdateCustodialMovementGuardedInput
  ): Promise<EarnMovementRow | null>;
}

export interface CreateSignedVaultDepositIntentInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  /** The vault's on-chain address. */
  vaultAddress: string;
  custodyWalletId: string;
  shareMint: string;
  tokenMint: string;
  label: string;
  /**
   * Decimal string in the vault token's units, as the caller sent it. Also what
   * settlement reports: `requireAcceptedPlan` asserts it numerically equal to
   * the plan's canonical amount before anything is signed, so the writer stamps
   * `amount_settled` from it once the chain speaks.
   */
  requestedAmount: string;
  acceptedMinSharesOut?: string | null;
  /** The wallet that signs and holds the shares — the depositor, on chain. */
  sourceAddress: string;
  signature: string;
  signedTransaction: string;
  lastValidBlockHeight: string;
  requestId: string;
  idempotencyFingerprint: string;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface AdvanceVaultMovementInput {
  movementId: string;
  organizationId: string;
  toStatus: string;
  sharesOut?: string | null;
  failureReason?: string | null;
  confirmedAt?: string | null;
  settledAt?: string | null;
}

export interface AdvanceVaultWithdrawalLegInput {
  movementId: string;
  legIndex: number;
  organizationId: string;
  toStatus: string;
  failureReason?: string | null;
  confirmedAt?: string | null;
  settledAt?: string | null;
}

/** One signed transaction leg of a vault withdrawal, ready to record. */
export interface SignedVaultWithdrawalLegInput {
  /**
   * Exact shares this leg's transaction encodes, as a decimal string in share
   * units — decoded from the instructions by the plan builder, never estimated.
   */
  shares: string;
  signature: string;
  signedTransaction: string;
  lastValidBlockHeight: string;
}

export interface CreateSignedVaultWithdrawalIntentInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  /** The EXISTING vault holding being exited; never created here. */
  positionId: string;
  /** Claim facts, FK-verified against the position row on insert. */
  vaultAddress: string;
  custodyWalletId: string;
  /**
   * The share mint — every withdrawal leg's `denomination` (0066): the exact
   * quantity a leg encodes is shares, and tokens received are chain-decided.
   */
  shareMint: string;
  /** Total caller intent in share units; stored once on the parent movement. */
  requestedShares: string;
  /** The custody wallet's public key: shares burn from it, tokens return to it. */
  walletAddress: string;
  /** Ordered internal transactions; the parent alone owns the caller's key. */
  legs: readonly SignedVaultWithdrawalLegInput[];
  requestId: string;
  idempotencyFingerprint: string;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface CreateCustodialMovementInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  /** The program wallet this movement is reached through; resolves the holding. */
  providerWalletId: string;
  /** USD decimal string (the portfolio vocabulary). */
  amountRequestedUsd: string;
  /** Payout stablecoin symbol; NOT the unit, which is always `usd` here. */
  payoutToken: string;
  destinationAddress: string;
  requestId: string;
  idempotencyFingerprint: string;
  providerData: Record<string, unknown>;
  createdBy: string | null;
  initiatedByKeyId: string | null;
}

export type UpdateCustodialMovementSelector =
  | { movementId: string }
  | { provider: string; providerReference: string };

export interface UpdateCustodialMovementGuardedInput {
  selector: UpdateCustodialMovementSelector;
  organizationId: string;
  toStatus: string;
  providerReference?: string;
  amountSettled?: string | null;
  feeAmount?: string | null;
  failureReason?: string | null;
  settledAt?: string | null;
  providerData?: Record<string, unknown>;
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
/** Mirrors 0062's amount format checks, so app-layer refusals match the DB's. */
const DECIMAL_STRING = /^\d+(?:\.\d+)?$/;
const NON_ZERO_DIGIT = /[1-9]/;

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

function mapVaultWithdrawalLegRow(row: Record<string, unknown>): EarnVaultWithdrawalLegRow {
  return {
    movement_id: row.movement_id as string,
    leg_index: row.leg_index as number,
    shares: row.shares as string,
    status: row.status as EarnMovementStatus,
    signature: row.signature as string,
    signed_transaction: row.signed_transaction as string,
    last_valid_block_height: row.last_valid_block_height as string,
    failure_reason: row.failure_reason as string | null,
    confirmed_at: row.confirmed_at as string | null,
    settled_at: row.settled_at as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

interface VaultWithdrawalAggregate {
  total: number;
  finalized: number;
  confirmed: number;
  started: number;
  failed: number;
  first_confirmed_at: string | null;
  last_settled_at: string | null;
  failure_reason: string | null;
  finalized_shares: string | null;
}

function vaultWithdrawalParentStatus(aggregate: VaultWithdrawalAggregate): EarnMovementStatus {
  if (aggregate.failed > 0) return "failed";
  if (aggregate.finalized === aggregate.total) return "finalized";
  if (aggregate.confirmed === aggregate.total) return "confirmed";
  if (aggregate.started > 0) return "submitted";
  return "requested";
}

async function updateVaultWithdrawalLeg(
  transaction: AppDb,
  input: AdvanceVaultWithdrawalLegInput
): Promise<Record<string, unknown> | null> {
  const sources = allowedSourceStatuses("vault_direct", input.toStatus);
  const assignments = ["status = ?", "updated_at = sdp_iso_now()"];
  const values: unknown[] = [input.toStatus];
  if (input.failureReason !== undefined) {
    assignments.push("failure_reason = ?");
    values.push(input.failureReason);
  }
  if (input.confirmedAt !== undefined) {
    assignments.push("confirmed_at = COALESCE(confirmed_at, ?)");
    values.push(input.confirmedAt);
  }
  if (input.settledAt !== undefined) {
    assignments.push("settled_at = ?");
    values.push(input.settledAt);
  }
  return transaction
    .prepare(
      `UPDATE earn_vault_withdrawal_legs
          SET ${assignments.join(", ")}
        WHERE movement_id = ? AND leg_index = ?
          AND status IN (${sources.map(() => "?").join(", ")})
        RETURNING *`
    )
    .bind(...values, input.movementId, input.legIndex, ...sources)
    .first<Record<string, unknown>>();
}

async function loadVaultWithdrawalAggregate(
  transaction: AppDb,
  movementId: string
): Promise<VaultWithdrawalAggregate | null> {
  return transaction
    .prepare(
      `SELECT
         COUNT(*)::integer AS total,
         COUNT(*) FILTER (WHERE status = 'finalized')::integer AS finalized,
         COUNT(*) FILTER (WHERE status IN ('confirmed', 'finalized'))::integer AS confirmed,
         COUNT(*) FILTER (WHERE status IN ('submitted', 'confirmed', 'finalized'))::integer AS started,
         COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
         MIN(confirmed_at) FILTER (WHERE confirmed_at IS NOT NULL) AS first_confirmed_at,
         MAX(settled_at) FILTER (WHERE settled_at IS NOT NULL) AS last_settled_at,
         MIN(failure_reason) FILTER (WHERE failure_reason IS NOT NULL) AS failure_reason,
         SUM(shares::numeric) FILTER (WHERE status = 'finalized')::text AS finalized_shares
       FROM earn_vault_withdrawal_legs WHERE movement_id = ?`
    )
    .bind(movementId)
    .first<VaultWithdrawalAggregate>();
}

async function updateVaultWithdrawalParent(
  transaction: AppDb,
  movementId: string,
  aggregate: VaultWithdrawalAggregate
): Promise<Record<string, unknown> | null> {
  const status = vaultWithdrawalParentStatus(aggregate);
  return transaction
    .prepare(
      `UPDATE earn_movements
          SET status = ?,
              failure_reason = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
              confirmed_at = CASE
                WHEN ? IN ('confirmed', 'finalized')
                THEN COALESCE(confirmed_at, ?)
                ELSE NULL
              END,
              settled_at = CASE WHEN ? = 'finalized' THEN ? ELSE NULL END,
              amount_settled = CASE
                WHEN ? IN ('confirmed', 'finalized') THEN amount_requested
                WHEN ? = 'failed' THEN ?
                ELSE NULL
              END,
              updated_at = sdp_iso_now()
        WHERE id = ?
        RETURNING *`
    )
    .bind(
      status,
      status,
      aggregate.failure_reason,
      status,
      aggregate.first_confirmed_at,
      status,
      aggregate.last_settled_at,
      status,
      status,
      aggregate.finalized_shares,
      movementId
    )
    .first<Record<string, unknown>>();
}

async function advanceVaultWithdrawalLegTransaction(
  transaction: AppDb,
  input: AdvanceVaultWithdrawalLegInput
): Promise<{ movement: EarnMovementRow; leg: EarnVaultWithdrawalLegRow } | null> {
  const parent = await transaction
    .prepare(
      `SELECT id FROM earn_movements
        WHERE id = ? AND organization_id = ?
          AND execution_model = 'vault_direct' AND direction = 'withdrawal'
        FOR UPDATE`
    )
    .bind(input.movementId, input.organizationId)
    .first<{ id: string }>();
  if (!parent) return null;

  const updated = await updateVaultWithdrawalLeg(transaction, input);
  if (!updated) return null;

  const aggregate = await loadVaultWithdrawalAggregate(transaction, input.movementId);
  if (!aggregate || aggregate.total < 1) {
    throw new Error(`Vault withdrawal ${input.movementId} has no transaction legs`);
  }
  const parentRow = await updateVaultWithdrawalParent(transaction, input.movementId, aggregate);
  if (!parentRow) throw new Error(`Vault withdrawal ${input.movementId} disappeared`);
  return {
    movement: mapMovementRow(parentRow),
    leg: mapVaultWithdrawalLegRow(updated),
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

    async listVaultMovements(params) {
      if (params.custodyWalletIds.length === 0) {
        throw new Error(
          "listVaultMovements requires at least one project-scoped custody wallet id"
        );
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
          // accepting it here would expose that project's movements to every
          // sibling project sharing an organization-level custody wallet.
          `SELECT * FROM earn_movements
             WHERE organization_id = ?
               AND environment = ?
               AND execution_model = 'vault_direct'
               AND direction = ?
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
          params.direction,
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

    async listVaultWithdrawalLegs(params) {
      return listWithdrawalLegs(db, params.organizationId, params.movementId);
    },

    async getVaultWithdrawalLegByIndex(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_vault_withdrawal_legs
            WHERE movement_id = ? AND leg_index = ?`
        )
        .bind(params.movementId, params.legIndex)
        .first<Record<string, unknown>>();
      return row ? mapVaultWithdrawalLegRow(row) : null;
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
                AND direction = 'deposit'
                AND status IN ('requested', 'submitted')
              ORDER BY COALESCE(reconciliation_attempted_at, created_at) ASC,
                       created_at ASC,
                       id ASC
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           ), confirmed AS MATERIALIZED (
             SELECT id FROM earn_movements
              WHERE execution_model = 'vault_direct'
                AND direction = 'deposit'
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
                AND movement.direction = 'deposit'
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

    async claimUnsettledVaultWithdrawalLegs(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
        throw new Error("Withdrawal reconciliation limit must be an integer from 1 to 256");
      }
      const confirmedQuota = limit > 1 ? Math.max(1, Math.floor(limit / 4)) : 0;
      const blockhashBoundQuota = limit - confirmedQuota;
      const result = await db
        .prepare(
          `WITH blockhash_bound AS MATERIALIZED (
             SELECT movement_id, leg_index FROM earn_vault_withdrawal_legs
              WHERE status IN ('requested', 'submitted')
              ORDER BY COALESCE(reconciliation_attempted_at, created_at) ASC,
                       created_at ASC, movement_id ASC, leg_index ASC
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           ), confirmed AS MATERIALIZED (
             SELECT movement_id, leg_index FROM earn_vault_withdrawal_legs
              WHERE status = 'confirmed'
              ORDER BY COALESCE(reconciliation_attempted_at, created_at) ASC,
                       created_at ASC, movement_id ASC, leg_index ASC
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           ), reserved AS MATERIALIZED (
             SELECT * FROM blockhash_bound
             UNION ALL
             SELECT * FROM confirmed
           ), overflow AS (
             SELECT leg.movement_id, leg.leg_index
               FROM earn_vault_withdrawal_legs leg
              WHERE leg.status IN ('requested', 'submitted', 'confirmed')
                AND NOT EXISTS (
                  SELECT 1 FROM reserved
                   WHERE reserved.movement_id = leg.movement_id
                     AND reserved.leg_index = leg.leg_index
                )
              ORDER BY (leg.status = 'confirmed') ASC,
                       COALESCE(leg.reconciliation_attempted_at, leg.created_at) ASC,
                       leg.created_at ASC, leg.movement_id ASC, leg.leg_index ASC
              LIMIT GREATEST(0, ? - (SELECT COUNT(*) FROM reserved))
              FOR UPDATE OF leg SKIP LOCKED
           ), claimed AS (
             SELECT * FROM reserved
             UNION ALL
             SELECT * FROM overflow
           ), touched AS (
             UPDATE earn_vault_withdrawal_legs leg
                SET reconciliation_attempted_at = sdp_iso_now()
               FROM claimed
              WHERE leg.movement_id = claimed.movement_id
                AND leg.leg_index = claimed.leg_index
             RETURNING leg.*
           )
           SELECT movement.*,
                  touched.movement_id AS outbox_movement_id,
                  touched.leg_index AS outbox_leg_index,
                  touched.shares AS outbox_shares,
                  touched.status AS outbox_status,
                  touched.signature AS outbox_signature,
                  touched.signed_transaction AS outbox_signed_transaction,
                  touched.last_valid_block_height AS outbox_last_valid_block_height,
                  touched.failure_reason AS outbox_failure_reason,
                  touched.confirmed_at AS outbox_confirmed_at,
                  touched.settled_at AS outbox_settled_at,
                  touched.created_at AS outbox_created_at,
                  touched.updated_at AS outbox_updated_at
             FROM touched
             JOIN earn_movements movement ON movement.id = touched.movement_id
            ORDER BY (touched.status = 'confirmed') ASC,
                     touched.created_at ASC, touched.movement_id ASC, touched.leg_index ASC`
        )
        .bind(blockhashBoundQuota, confirmedQuota, limit)
        .all<Record<string, unknown>>();
      return (result.results ?? []).map((row) => ({
        movement: mapMovementRow(row),
        leg: mapVaultWithdrawalLegRow({
          movement_id: row.outbox_movement_id,
          leg_index: row.outbox_leg_index,
          shares: row.outbox_shares,
          status: row.outbox_status,
          signature: row.outbox_signature,
          signed_transaction: row.outbox_signed_transaction,
          last_valid_block_height: row.outbox_last_valid_block_height,
          failure_reason: row.outbox_failure_reason,
          confirmed_at: row.outbox_confirmed_at,
          settled_at: row.outbox_settled_at,
          created_at: row.outbox_created_at,
          updated_at: row.outbox_updated_at,
        }),
      }));
    },

    async createSignedVaultDepositIntent(input) {
      // A real transaction for ordinary requests. When the caller supplied an
      // approved-operation transaction, asTransactionalClient makes this nested
      // call execute inline on that same connection.
      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);

        const prior = await findVaultMovementByRequest(
          transaction,
          input.organizationId,
          input.requestId
        );
        if (prior) {
          assertMovementIsOwnReplay(prior, input);
          return {
            position: await requireMovementPosition(transaction, prior),
            movement: prior,
            replayed: true,
          };
        }

        const claimed = await claimVaultPosition(transaction, input);
        const inserted = await insertVaultMovement(transaction, input, claimed.id);
        if (!inserted) {
          // A concurrent request committed after the preflight. A divergent
          // fingerprint throws and rolls the claim back with this transaction.
          const winner = await findVaultMovementByRequest(
            transaction,
            input.organizationId,
            input.requestId
          );
          if (!winner) throw new Error("Failed to resolve concurrent earn vault movement");
          assertMovementIsOwnReplay(winner, input);
          return {
            position: await requireMovementPosition(transaction, winner),
            movement: winner,
            replayed: true,
          };
        }

        return { position: claimed, movement: inserted, replayed: false };
      });
    },

    async createSignedVaultWithdrawalIntent(input) {
      if (input.legs.length === 0) {
        throw new Error("A vault withdrawal intent needs at least one signed leg");
      }
      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);

        const resolveReplay = async () => {
          const prior = await findVaultMovementByRequest(
            transaction,
            input.organizationId,
            input.requestId
          );
          if (!prior) return null;
          assertMovementIsOwnReplay(prior, input);
          if (prior.direction !== "withdrawal") {
            throw conflict("Idempotency key already used with different request payload");
          }
          return {
            position: await requireMovementPosition(transaction, prior),
            movement: prior,
            legs: await listWithdrawalLegs(transaction, input.organizationId, prior.id),
            replayed: true,
          };
        };

        const prior = await resolveReplay();
        if (prior) return prior;

        const movement = await insertVaultWithdrawalMovement(transaction, input);
        if (!movement) {
          // A concurrent identical request committed after the preflight; its
          // signed legs — not ours — are the ones that may be broadcast.
          const winner = await resolveReplay();
          if (!winner) throw new Error("Failed to resolve concurrent earn vault withdrawal");
          return winner;
        }
        const legs = await insertVaultWithdrawalLegs(transaction, movement.id, input);
        return {
          position: await requireMovementPosition(transaction, movement),
          movement,
          legs,
          replayed: false,
        };
      });
    },

    async advanceVaultMovement(input) {
      assertVaultTransitionMetadata(input);
      const sources = allowedSourceStatuses("vault_direct", input.toStatus);
      const guards = sources.map(() => "?").join(", ");

      const assignments = ["status = ?", "updated_at = sdp_iso_now()"];
      const values: unknown[] = [input.toStatus];
      for (const [column, value] of [
        ["shares_out", input.sharesOut],
        ["failure_reason", input.failureReason],
        ["settled_at", input.settledAt],
      ] as const) {
        if (value !== undefined) {
          assignments.push(`${column} = ?`);
          values.push(value);
        }
      }
      if (input.confirmedAt !== undefined) {
        // COALESCEd rather than overwritten: a sweep whose first observation is
        // already finalized never saw a separate commitment, and 0062 requires the
        // column for any confirmed-or-finalized row — while a movement that DID
        // report commitment earlier keeps the moment it was actually observed.
        assignments.push("confirmed_at = COALESCE(confirmed_at, ?)");
        values.push(input.confirmedAt);
      }
      if (input.toStatus === "confirmed" || input.toStatus === "finalized") {
        // What moved is what the intent encoded: the service asserts the caller's
        // amount numerically equal to the plan's canonical amount before signing,
        // so once the chain speaks the requested amount IS the settled amount —
        // the same fact 0063's projection derived for the backfilled history.
        // COALESCEd so a backfilled row keeps the projection's spelling.
        assignments.push("amount_settled = COALESCE(amount_settled, amount_requested)");
      }

      const advance = (target: AppDb) =>
        target
          .prepare(
            `UPDATE earn_movements
                SET ${assignments.join(", ")}
              WHERE id = ?
                AND organization_id = ?
                AND execution_model = 'vault_direct'
                AND status IN (${guards})
              RETURNING *`
          )
          .bind(...values, input.movementId, input.organizationId, ...sources)
          .first<Record<string, unknown>>();

      // Only an outcome that changes what the organization HOLDS needs the
      // position lock and the second statement.
      if (input.toStatus === "submitted") {
        const row = await advance(db);
        return row ? mapMovementRow(row) : null;
      }

      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);
        const candidate = await transaction
          .prepare(
            `SELECT position_id, direction FROM earn_movements
              WHERE id = ? AND organization_id = ?`
          )
          .bind(input.movementId, input.organizationId)
          .first<{ position_id: string; direction: string }>();
        if (!candidate) return null;
        // Serialises concurrent activation decisions for this holding.
        await transaction
          .prepare("SELECT id FROM earn_positions WHERE id = ? FOR UPDATE")
          .bind(candidate.position_id)
          .first<{ id: string }>();
        const row = await advance(transaction);
        if (!row) return null;
        const movement = mapMovementRow(row);

        if (input.toStatus === "failed") {
          // De-activate only when nothing live remains: a failed attempt beside a
          // good one must not close a holding the organization still has.
          await transaction
            .prepare(
              `UPDATE earn_positions position
                  SET activated_at = NULL, updated_at = sdp_iso_now()
                WHERE position.id = ?
                  AND position.activated_at IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM earn_movements movement
                     WHERE movement.position_id = position.id
                       AND movement.status IN ('requested', 'submitted', 'confirmed', 'finalized')
                  )`
            )
            .bind(movement.position_id)
            .run();
        } else if (candidate.direction === "deposit") {
          await transaction
            .prepare(
              `UPDATE earn_positions
                  SET activated_at = COALESCE(activated_at, sdp_iso_now()),
                      closed_at = NULL,
                      updated_at = sdp_iso_now()
                WHERE id = ? AND organization_id = ?`
            )
            .bind(movement.position_id, input.organizationId)
            .run();
        }
        return movement;
      });
    },

    async advanceVaultWithdrawalLeg(input) {
      if (input.confirmedAt !== undefined && !["confirmed", "finalized"].includes(input.toStatus)) {
        throw new Error("confirmedAt is only valid when confirming a withdrawal leg");
      }
      if (["confirmed", "finalized"].includes(input.toStatus) && !input.confirmedAt?.trim()) {
        throw new Error("confirmedAt is required when confirming a withdrawal leg");
      }
      if (input.settledAt !== undefined && input.toStatus !== "finalized") {
        throw new Error("settledAt is only valid when finalizing a withdrawal leg");
      }
      if (input.toStatus === "finalized" && !input.settledAt?.trim()) {
        throw new Error("settledAt is required when finalizing a withdrawal leg");
      }
      if (input.failureReason !== undefined && input.toStatus !== "failed") {
        throw new Error("failureReason is only valid when failing a withdrawal leg");
      }
      if (input.toStatus === "failed" && !input.failureReason?.trim()) {
        throw new Error("failureReason is required when failing a withdrawal leg");
      }

      return db.transaction((executor) =>
        advanceVaultWithdrawalLegTransaction(asTransactionalClient(executor), input)
      );
    },

    async createCustodialMovement(input) {
      // Status, denomination and direction are fixed for this shape: an intent row
      // exists before the provider call is accepted and never in another state, and
      // a portfolio withdrawal is USD-denominated by definition. The holding is
      // resolved by JOIN rather than passed in, so a movement can never name one
      // that does not belong to its program.
      const insert = () =>
        db
          .prepare(
            `INSERT INTO earn_movements (
             id, organization_id, project_id, environment, provider,
             execution_model, direction, position_id, status,
             denomination, amount_requested, payout_token, destination_address,
             request_id, idempotency_fingerprint, provider_data,
             created_by, initiated_by_key_id
           )
           SELECT ?, ?, ?, ?, ?, 'custodial', 'withdrawal', position.id, 'requested',
                  'usd', ?, ?, ?, ?, ?, ?::jsonb, ?, ?
             FROM earn_positions position
            WHERE position.provider_wallet_id = ?
              AND position.kind = 'custodial'
           RETURNING *`
          )
          .bind(
            generateEarnMovementId(),
            input.organizationId,
            input.projectId,
            input.environment,
            input.provider,
            input.amountRequestedUsd,
            input.payoutToken,
            input.destinationAddress,
            input.requestId,
            input.idempotencyFingerprint,
            JSON.stringify(input.providerData ?? {}),
            input.createdBy,
            input.initiatedByKeyId,
            input.providerWalletId
          )
          .first<Record<string, unknown>>();

      const row = await insert();
      if (row) return mapMovementRow(row);

      // Zero rows means the JOIN found no holding for this program. Open one and
      // retry rather than failing: a program linked by a revision that predates
      // the ledger, or during a rollout or rollback window, has no holding
      // through no fault of the caller, and refusing here takes that program's
      // whole withdrawal endpoint down permanently until an operator intervenes.
      // The mint is insert-only and guarded on the wallet, so this is safe to
      // race.
      await mintEarnPositionForProviderWallet(db, input.providerWalletId);
      const healed = await insert();
      if (!healed) {
        // Still nothing: the program wallet itself does not exist, which is a
        // caller bug rather than a gap in the ledger. Loud, because the
        // alternative is money moving unrecorded.
        throw new Error(
          `Earn program wallet ${input.providerWalletId} has no custodial holding to record a movement against`
        );
      }
      return mapMovementRow(healed);
    },

    async updateCustodialMovementGuarded(input) {
      // Dynamic SET list, payments idiom: `undefined` means "don't touch", `null`
      // is a real write; provider_data is a shallow JSONB merge. updated_at is
      // DB-stamped (earn convention), never caller-supplied.
      const assignments = ["status = ?", "updated_at = sdp_iso_now()"];
      const assignmentValues: unknown[] = [input.toStatus];
      for (const [column, value] of [
        ["provider_reference", input.providerReference],
        ["amount_settled", input.amountSettled],
        ["fee_amount", input.feeAmount],
        ["failure_reason", input.failureReason],
        ["settled_at", input.settledAt],
      ] as const) {
        if (value !== undefined) {
          assignments.push(`${column} = ?`);
          assignmentValues.push(value);
        }
      }
      if (input.providerData !== undefined) {
        assignments.push("provider_data = provider_data || ?::jsonb");
        assignmentValues.push(JSON.stringify(input.providerData));
      }

      // The CAS guard and the org scope live in the same WHERE as the selector, so
      // the whole transition is one atomic statement: the loser of a concurrent
      // race simply matches zero rows.
      const conditions = [
        "organization_id = ?",
        "execution_model = 'custodial'",
        "status = ANY(?)",
      ];
      const conditionValues: unknown[] = [
        input.organizationId,
        // From the shared matrix, never the caller: terminal statuses appear in no
        // source list, so regression is unrepresentable rather than merely refused.
        [...allowedSourceStatuses("custodial", input.toStatus)],
      ];
      if ("movementId" in input.selector) {
        conditions.push("id = ?");
        conditionValues.push(input.selector.movementId);
      } else {
        conditions.push("provider = ?", "provider_reference = ?");
        conditionValues.push(input.selector.provider, input.selector.providerReference);
      }

      const row = await db
        .prepare(
          `UPDATE earn_movements
              SET ${assignments.join(", ")}
            WHERE ${conditions.join(" AND ")}
            RETURNING *`
        )
        .bind(...assignmentValues, ...conditionValues)
        .first<Record<string, unknown>>();
      return row ? mapMovementRow(row) : null;
    },
  };
}

/**
 * Field coupling for a vault transition, checked before the statement runs.
 *
 * These throw rather than miss the CAS, because a caller asking to confirm without
 * a timestamp or fail without a reason has a bug — and 0062 would refuse the write
 * anyway. Failing here names the actual mistake instead of returning the null that
 * means "someone else got there first".
 */
function assertVaultTransitionMetadata(input: AdvanceVaultMovementInput): void {
  if (input.failureReason !== undefined && input.toStatus !== "failed") {
    throw new Error("failureReason is only valid when failing an earn vault movement");
  }
  if (input.toStatus === "failed" && !input.failureReason?.trim()) {
    throw new Error("failureReason is required when failing an earn vault movement");
  }
  if (input.settledAt !== undefined && input.toStatus !== "finalized") {
    throw new Error("settledAt is only valid when finalizing an earn vault movement");
  }
  if (input.toStatus === "finalized" && !input.settledAt?.trim()) {
    throw new Error("settledAt is required when finalizing an earn vault movement");
  }
  if (
    input.confirmedAt !== undefined &&
    input.toStatus !== "confirmed" &&
    input.toStatus !== "finalized"
  ) {
    throw new Error("confirmedAt is only valid when confirming an earn vault movement");
  }
  if (
    (input.toStatus === "confirmed" || input.toStatus === "finalized") &&
    !input.confirmedAt?.trim()
  ) {
    throw new Error("confirmedAt is required when confirming an earn vault movement");
  }
  if (input.sharesOut !== undefined && input.toStatus !== "confirmed") {
    throw new Error("sharesOut is only valid when confirming an earn vault movement");
  }
  if (
    input.sharesOut !== undefined &&
    input.sharesOut !== null &&
    (input.sharesOut.length < 1 ||
      input.sharesOut.length > 128 ||
      !DECIMAL_STRING.test(input.sharesOut) ||
      !NON_ZERO_DIGIT.test(input.sharesOut))
  ) {
    throw new Error("sharesOut must be a positive unsigned decimal with at most 128 characters");
  }
}

async function listWithdrawalLegs(
  db: AppDb,
  organizationId: string,
  movementId: string
): Promise<EarnVaultWithdrawalLegRow[]> {
  const result = await db
    .prepare(
      `SELECT leg.* FROM earn_vault_withdrawal_legs leg
        JOIN earn_movements movement ON movement.id = leg.movement_id
       WHERE movement.organization_id = ? AND movement.id = ?
       ORDER BY leg.leg_index ASC`
    )
    .bind(organizationId, movementId)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(mapVaultWithdrawalLegRow);
}

/**
 * One logical withdrawal movement, inserted before any signed bytes broadcast.
 *
 * The two composite FKs onto `earn_positions` are the claim check: a leg whose
 * (position, organization, environment, provider, vault, wallet) tuple does not
 * exactly match the holding fails the INSERT rather than recording money
 * against someone else's claim. Denomination is the SHARE MINT and
 * `amount_requested` the exact shares this leg's transaction encodes — see
 * 0066's header for why a withdrawal is not token-denominated.
 */
async function insertVaultWithdrawalMovement(
  db: AppDb,
  input: CreateSignedVaultWithdrawalIntentInput
): Promise<EarnMovementRow | null> {
  const row = await db
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id, status,
         denomination, amount_requested,
         custody_wallet_id, vault_address, source_address, destination_address,
         request_id, idempotency_fingerprint,
         created_by, initiated_by_key_id
       ) VALUES (?, ?, ?, ?, ?, 'vault_direct', 'withdrawal', ?, 'requested',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, request_id) WHERE execution_model = 'vault_direct'
       DO NOTHING
       RETURNING *`
    )
    .bind(
      generateEarnMovementId(),
      input.organizationId,
      input.projectId,
      input.environment,
      input.provider,
      input.positionId,
      input.shareMint,
      input.requestedShares,
      input.custodyWalletId,
      input.vaultAddress,
      // Money leaves the INSTRUMENT and returns to the org's own wallet — the
      // mirror image of a deposit's source/destination.
      input.vaultAddress,
      input.walletAddress,
      input.requestId,
      input.idempotencyFingerprint,
      input.createdBy ?? null,
      input.initiatedByKeyId ?? null
    )
    .first<Record<string, unknown>>();
  return row ? mapMovementRow(row) : null;
}

async function insertVaultWithdrawalLegs(
  db: AppDb,
  movementId: string,
  input: CreateSignedVaultWithdrawalIntentInput
): Promise<EarnVaultWithdrawalLegRow[]> {
  if (input.legs.length === 0) return [];
  const values = input.legs.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
  const bindings = input.legs.flatMap((leg, legIndex) => [
    movementId,
    legIndex,
    leg.shares,
    leg.signature,
    leg.signedTransaction,
    leg.lastValidBlockHeight,
  ]);
  const rows = await db.queryMany<Record<string, unknown>>(
    `INSERT INTO earn_vault_withdrawal_legs (
       movement_id, leg_index, shares, signature, signed_transaction, last_valid_block_height
     ) VALUES ${values}
     RETURNING *`,
    bindings
  );
  if (rows.length !== input.legs.length) {
    throw new Error("Failed to record every earn vault withdrawal leg");
  }
  return rows.map(mapVaultWithdrawalLegRow).sort((left, right) => left.leg_index - right.leg_index);
}

async function findVaultMovementByRequest(
  db: AppDb,
  organizationId: string,
  requestId: string
): Promise<EarnMovementRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM earn_movements
        WHERE organization_id = ? AND request_id = ? AND execution_model = 'vault_direct'`
    )
    .bind(organizationId, requestId)
    .first<Record<string, unknown>>();
  return row ? mapMovementRow(row) : null;
}

async function requireMovementPosition(
  db: AppDb,
  movement: EarnMovementRow
): Promise<EarnPositionRow> {
  const position = await db
    .prepare(
      `SELECT * FROM earn_positions WHERE id = ? AND organization_id = ? AND environment = ?`
    )
    .bind(movement.position_id, movement.organization_id, movement.environment)
    .first<EarnPositionRow>();
  if (!position) {
    throw new Error(
      `Earn movement ${movement.id} references missing holding ${movement.position_id}`
    );
  }
  return position;
}

/**
 * Claim or refresh the vault holding, taking tenancy FROM the project row rather
 * than from the input, and validating the wallet's config-or-connection scope in
 * SQL. A mint-identity mismatch returns nothing and answers 409: the caller named a
 * holding whose asset identity is not the one being deposited.
 */
async function claimVaultPosition(
  db: AppDb,
  input: CreateSignedVaultDepositIntentInput
): Promise<EarnPositionRow> {
  const row = await db
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         custody_wallet_id, vault_address, share_mint, token_mint, label,
         created_by, activated_at
       )
       SELECT
         ?, project.organization_id, project.id, project.environment,
         ?, 'vault_direct', wallet.id, ?, ?, ?, ?, ?, sdp_iso_now()
       FROM projects project
       INNER JOIN custody_wallets wallet
         ON wallet.id = ?
       LEFT JOIN custody_configs config
         ON config.id = wallet.custody_config_id
       LEFT JOIN custody_connections connection
         ON connection.id = wallet.custody_connection_id
       WHERE project.id = ?
         AND project.organization_id = ?
         AND project.environment = ?
         AND (
           (
             wallet.custody_config_id IS NOT NULL
             AND config.organization_id = project.organization_id
             AND (config.project_id IS NULL OR config.project_id = project.id)
           )
           OR
           (
             wallet.custody_connection_id IS NOT NULL
             AND connection.organization_id = project.organization_id
             AND (connection.project_id IS NULL OR connection.project_id = project.id)
           )
         )
       ON CONFLICT (organization_id, environment, provider, vault_address, custody_wallet_id)
         WHERE kind = 'vault_direct'
       DO UPDATE SET
         updated_at = sdp_iso_now(),
         label = EXCLUDED.label,
         activated_at = COALESCE(earn_positions.activated_at, sdp_iso_now())
       WHERE earn_positions.token_mint = EXCLUDED.token_mint
         AND earn_positions.share_mint = EXCLUDED.share_mint
       RETURNING *`
    )
    .bind(
      generateEarnPositionId(),
      input.provider,
      input.vaultAddress,
      input.shareMint,
      input.tokenMint,
      input.label,
      input.createdBy ?? null,
      input.custodyWalletId,
      input.projectId,
      input.organizationId,
      input.environment
    )
    .first<EarnPositionRow>();
  if (!row) {
    throw conflict("Vault position does not match project, wallet scope, or asset identity");
  }
  return row;
}

async function insertVaultMovement(
  db: AppDb,
  input: CreateSignedVaultDepositIntentInput,
  positionId: string
): Promise<EarnMovementRow | null> {
  const row = await db
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id, status,
         denomination, amount_requested, min_shares_out,
         custody_wallet_id, vault_address, source_address, destination_address,
         signature, signed_transaction, last_valid_block_height,
         request_id, idempotency_fingerprint, created_by, initiated_by_key_id
       ) VALUES (?, ?, ?, ?, ?, 'vault_direct', 'deposit', ?, 'requested',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, request_id) WHERE execution_model = 'vault_direct'
       DO NOTHING
       RETURNING *`
    )
    .bind(
      generateEarnMovementId(),
      input.organizationId,
      input.projectId,
      input.environment,
      input.provider,
      positionId,
      // Mint units, never USD — the denomination IS the deposit token.
      input.tokenMint,
      input.requestedAmount,
      input.acceptedMinSharesOut ?? null,
      input.custodyWalletId,
      input.vaultAddress,
      input.sourceAddress,
      // Funds go INTO the vault, so the instrument is also the destination.
      input.vaultAddress,
      input.signature,
      input.signedTransaction,
      input.lastValidBlockHeight,
      input.requestId,
      input.idempotencyFingerprint,
      input.createdBy ?? null,
      input.initiatedByKeyId ?? null
    )
    .first<Record<string, unknown>>();
  return row ? mapMovementRow(row) : null;
}

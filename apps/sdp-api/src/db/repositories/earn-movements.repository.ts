import type {
  EarnExecutionModel,
  EarnMovementDirection,
  EarnMovementStatus,
  SdpEnvironment,
} from "@sdp/types";
import {
  EARN_MOVEMENT_TRANSITIONS,
  EARN_PROVIDER_DEPOSIT_SETTLEMENT,
  EARN_PROVIDER_WITHDRAWAL_SETTLEMENT,
} from "@sdp/types";
import { type AppDb, asTransactionalClient, type DatabaseExecutor } from "@/db";
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
 * `earn_vault_positions`) are gone, dropped by migration 0068 along with the
 * projection views that carried their history across.
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
  /** vault_direct only, SDP-signed shape: the custody wallet holds the shares. */
  custody_wallet_id: string | null;
  /**
   * vault_direct only, EXTERNAL-WALLET shape (PRO-1722): the non-custodial wallet
   * that signs and holds the shares. Exactly one of this and
   * `custody_wallet_id` is set on a vault row; SDP holds no key for it.
   */
  owner_address: string | null;
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
  /**
   * Address owed this position's share-ATA rent back when the exit closes that
   * account. Null means the custody wallet funded it and keeps it.
   *
   * A PROJECTION of `earn_movements` (migration 0067), not an independent fact:
   * the funder named by the newest movement that claimed to create this share
   * account and has not failed. That is what makes it self-repairing. A claim
   * whose transaction never lands drops out when reconciliation fails the
   * movement, falling back to the previous surviving claimant rather than
   * outliving its own transaction, and a movement that lost its idempotency
   * insert has no row to contribute at all.
   *
   * Authoritative WHENEVER THE SHARE ACCOUNT EXISTS, which is the only window
   * anything reads it: a position with no share account has no shares to exit.
   */
  share_ata_rent_funder: string | null;
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
  /**
   * What settled in the position's DEPOSIT token (migration 0103): the deposit
   * amount, or a withdrawal's observed payout from the finalized transaction.
   * NULL until finalized, and NULL when a payout could not be observed.
   */
  token_amount_settled: string | null;
  /** Share units, never comparable to the amount columns. */
  min_shares_out: string | null;
  shares_out: string | null;
  /** Legacy custodial payout stablecoin symbol; NOT the asset identity. */
  payout_token: string | null;
  custody_wallet_id: string | null;
  /** The external (non-custodial) wallet that signed this movement; exactly one of this and
   * `custody_wallet_id` is set on a vault row (PRO-1722). */
  owner_address: string | null;
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
  /**
   * Whether this movement was OBSERVED to create the owner's share token
   * account, and so charged its rent. The position's funder projects from the
   * newest non-failed movement carrying this (migration 0067).
   */
  creates_share_account: boolean;
  /** Who this movement charged that rent to. Null means the custody wallet. */
  share_ata_rent_funder: string | null;
  /**
   * When the sweep first saw this SUBMITTED movement's signature unknown to
   * RPC after its blockhash window closed (migration 0092, PRO-1904). One
   * observation parks the row; a second on a later tick expires it.
   */
  unknown_signature_observed_at: string | null;
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
   * of this query: deposits and withdrawals share every scoping rule
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
   * The COMPLETE set of claims `listVaultPositions` would serve (same
   * visibility predicate, unpaged — a reconciliation over a page would clear
   * discrepancies it never looked at), each with whether any of its movements
   * is still unsettled. Read-only input to share reconciliation (PRO-1741);
   * empty wallet scope answers empty rather than throwing, because "this key
   * sees no wallets" is a legitimate reconciliation answer.
   */
  listVaultClaimsForReconciliation(params: {
    organizationId: string;
    environment: SdpEnvironment;
    custodyWalletIds: readonly string[];
  }): Promise<Array<EarnPositionRow & { has_unsettled_movements: boolean }>>;
  /** External-wallet vault claims, exact-project scoped, newest first. */
  listExternalWalletPositions(params: {
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    ownerAddress?: string;
    limit: number;
    before: EarnMovementCursor | null;
  }): Promise<{ rows: EarnPositionRow[]; hasMore: boolean }>;
  /**
   * Deposit-token mint per position id, organization scoped. The movement
   * wire shape names the token a withdrawal pays out in, and a withdrawal row
   * only carries its SHARE mint, so the position supplies it.
   */
  listPositionTokenMints(params: {
    organizationId: string;
    positionIds: readonly string[];
  }): Promise<Map<string, string>>;
  /**
   * Stamp `closed_at` on a vault position the caller has just observed EMPTY
   * on chain (live shares "0" after a finalized withdrawal). Takes the same
   * position lock `advanceVaultMovement` takes, so it serialises against a
   * concurrent deposit transition; that transition re-opens (`closed_at =
   * NULL`) whenever it runs later, and the visibility predicates already show
   * a closed row while a deposit re-entry is pending. Returns true when this
   * call closed the row, false when it was already closed or not found.
   */
  closeVaultPositionIfEmpty(params: {
    positionId: string;
    organizationId: string;
    /**
     * The position row's `updated_at` as read BEFORE the balance observation.
     * Every deposit transition bumps it while re-opening the row, so a stale
     * zero-share snapshot can never close a holding a deposit refilled in the
     * meantime: the close is refused and the next observation decides.
     */
    observedUpdatedAt: string;
  }): Promise<boolean>;
  /**
   * Finalized withdrawals whose payout was not observed at settlement
   * (`token_amount_settled IS NULL`), oldest attempt first, bounded to rows
   * settled after `settledAfter` (RPC transaction history is finite) and not
   * attempted since `retryBefore`. Stamps `reconciliation_attempted_at` on the
   * claim so the repair sweep spaces its retries.
   */
  claimUnvaluedWithdrawalPayouts(params: {
    limit: number;
    settledAfter: string;
    retryBefore: string;
  }): Promise<EarnMovementRow[]>;
  /**
   * Record a payout observed after settlement. Writes only a finalized
   * withdrawal that is still unvalued, so a repeated observation never
   * overwrites the first one. Returns true when this call recorded it.
   */
  recordWithdrawalPayout(params: {
    movementId: string;
    organizationId: string;
    tokenAmountSettled: string;
  }): Promise<boolean>;
  /**
   * One external wallet's recorded movements, exact-project scoped, newest
   * first (PRO-1772). The per-owner read the cross-provider feed structurally
   * cannot serve: its vault arm requires a custody-wallet match, and an
   * owner-signed row has none. Scope is the 0070 claim key — org, PROJECT,
   * environment, owner — so a sibling project sees nothing.
   */
  listExternalWalletMovements(params: {
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    ownerAddress: string;
    direction?: EarnMovementDirection;
    status?: string;
    limit: number;
    before: EarnMovementCursor | null;
  }): Promise<{ rows: EarnMovementRow[]; hasMore: boolean }>;
  /**
   * Every external-wallet DEPOSIT movement for one owner and deposit token
   * created strictly after a moment, oldest first (PRO-1864). The orphaned
   * split-swap detector reads these with their STATUS: a `failed` deposit must
   * not discharge an advisory, and a still-`requested` one is in flight, not
   * observed. Matches on the deposit token rather than the vault on purpose: a
   * partner may legitimately deposit the swapped tokens into a sibling
   * strategy of the same token, and the funds reached a vault either way.
   */
  listExternalWalletDepositsSince(params: {
    organizationId: string;
    projectId: string | null;
    environment: SdpEnvironment;
    ownerAddress: string;
    depositTokenMint: string;
    createdAfter: string;
  }): Promise<EarnMovementRow[]>;
  /** One external-wallet movement under the same four scoping rules, or null. */
  getExternalWalletMovement(params: {
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    movementId: string;
  }): Promise<EarnMovementRow | null>;
  /**
   * Ledger inputs to the per-owner earnings figure, grouped by position
   * (PRO-1772): finalized deposit total and finalized withdrawal payout total
   * (both in deposit-token units, from `token_amount_settled`, so the SUMs
   * never cross denominations), how many finalized withdrawals carry NO
   * observed payout, and how many movements are still unsettled. Failed
   * movements are ignored: that money never moved.
   */
  aggregateExternalWalletMovements(params: {
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    ownerAddress: string;
  }): Promise<Map<string, ExternalWalletMovementTotals>>;
  /**
   * SDP-wide money INTO one vault, summed across every organization on the
   * environment (ADR 0004 layer 1, PRO-1934): non-failed vault deposits
   * (`requested`, `submitted`, `confirmed`, `finalized`) in the vault's
   * deposit-token units. In-flight deposits count on purpose, so a burst of
   * concurrent deposits cannot each see the pre-burst figure. Never negative.
   *
   * Withdrawals are deliberately NOT subtracted: a vault exit is ledgered in
   * SHARES (`denomination` = the share mint, and `amount_settled` is stamped
   * from `amount_requested` on finalization, also shares), so the ledger holds
   * no token-denominated figure for money OUT, and this table's own rule is
   * that no read sums across denominations. The result is therefore GROSS
   * inflow: an over-estimate of exposure that only ever errs toward refusing a
   * deposit, never toward admitting one, which is the ADR's fail-closed side.
   * Recording the observed token payout at exit settlement is the follow-up
   * that turns this into a net figure (the earnings read has the same gap,
   * `withdrawals_not_valued`).
   *
   * Cross-tenant by design; the caller runs it under the system database
   * identity and folds the answer into one aggregate.
   */
  sumVaultDepositExposure(params: {
    environment: SdpEnvironment;
    provider: string;
    vaultAddress: string;
  }): Promise<string>;
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
  /**
   * Atomically select a fair, bounded batch and rotate its attempt cursor; not a work lease.
   *
   * Provider-order rows parked at `confirmed` are NOT in the queue: no chain
   * read can advance them until a Connect completion reconciler exists, so
   * scheduling them would be permanent work for a fact the wire already gave.
   */
  claimUnsettledVaultMovements(limit: number): Promise<EarnMovementRow[]>;
  /**
   * Backlog telemetry over the SAME predicate the claim uses (PRO-1863): how
   * many vault movements remain unsettled, and how old the oldest one is. Read
   * after a sweep tick so the reported backlog is what the tick left behind.
   *
   * Dimensioned, because the flat total is not alertable. A `confirmed` row
   * whose signature ages out of RPC history is a PERMANENT member of this set
   * (PRO-1716 gives `confirmed` no exit but `finalized`, and the sweep must
   * neither expire nor rebroadcast it), so a total-only age would latch and
   * page forever. `blockhashBound` is the actionable subset the sweep can
   * still act on, and the withdrawal split keeps the exit path visible on its
   * own (ADR 0002). Provider-order rows parked at `confirmed` are excluded
   * here exactly as they are from the claim — they are awaiting-provider
   * surface, not sweep backlog.
   */
  getUnsettledVaultMovementStats(): Promise<{
    backlog: number;
    backlogBlockhashBound: number;
    backlogConfirmed: number;
    backlogWithdrawals: number;
    oldestUnsettledCreatedAt: string | null;
    oldestBlockhashBoundCreatedAt: string | null;
    oldestWithdrawalCreatedAt: string | null;
  }>;

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
   * Atomically record one signed vault withdrawal against an EXISTING holding.
   * Never creates or activates a holding: an exit is only ever
   * asked of a position the organization already holds, and the movement
   * rows' composite FK onto that position is what refuses a claim whose vault
   * or wallet does not match. A divergent idempotency loser throws so the
   * transaction rolls back; an identical loser returns the winning movement.
   */
  createSignedVaultWithdrawalIntent(input: CreateSignedVaultWithdrawalIntentInput): Promise<{
    position: EarnPositionRow;
    movement: EarnMovementRow;
    replayed: boolean;
  }>;
  /**
   * Atomically consume one BUILT external-wallet transaction into a signed deposit
   * movement: claim/refresh the external-wallet holding, insert the movement, mark
   * the built transaction consumed, and activate the holding (PRO-1722).
   *
   * The built-transaction row is locked FIRST: one built transaction can land
   * on chain at most once, so a second submit under a different idempotency
   * key must answer a clean conflict instead of racing the movement insert
   * into the ledger's unique signature index. A same-key retry resolves the
   * recorded movement as a replay before that conflict is reachable.
   */
  createSignedExternalWalletDepositIntent(
    input: CreateSignedExternalWalletDepositIntentInput
  ): Promise<{
    position: EarnPositionRow;
    movement: EarnMovementRow;
    replayed: boolean;
  }>;
  /**
   * The withdrawal mirror of the above, against an EXISTING external-wallet holding.
   * Never creates or activates a holding; the movement's composite FK onto
   * (vault, owner) is what refuses a claim that does not match the position.
   */
  createSignedExternalWalletWithdrawalIntent(
    input: CreateSignedExternalWalletWithdrawalIntentInput
  ): Promise<{
    position: EarnPositionRow;
    movement: EarnMovementRow;
    replayed: boolean;
  }>;
  /**
   * Guarded CAS on a vault movement. Legal source states come from the shared
   * transition matrix, so terminal regression is unrepresentable rather than
   * merely discouraged, and a lost race returns null rather than an error.
   */
  advanceVaultMovement(input: AdvanceVaultMovementInput): Promise<EarnMovementRow | null>;
  /**
   * The sweep's first piece of evidence that a SUBMITTED vault movement did not
   * land (PRO-1904): its signature came back unknown after the blockhash window
   * closed. Idempotent (COALESCE) and status-guarded, so a burst of ticks
   * records one observation and a row that has since moved on is untouched.
   * Returns the row when the mark was written or already present, null when
   * the row is no longer `submitted`.
   */
  recordUnknownSignatureObservation(input: {
    movementId: string;
    organizationId: string;
  }): Promise<EarnMovementRow | null>;
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

export interface CreateSignedVaultDepositIntentInput
  extends ShareAccountRentAttribution,
    LedgerAdmissionHook {
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

/**
 * A platform admission re-check that runs INSIDE the ledger transaction that
 * records a deposit's `requested` row: after the per-vault write lock
 * (`earnVaultDepositWriteLockKey`) is held and the idempotency replay has been
 * re-checked under it, before the holding is claimed. It receives the
 * transaction's own executor, so every statement it issues sees the previous
 * lock holder's commit, and a throw rolls the whole write back with nothing
 * recorded.
 *
 * The one caller today is the vault exposure cap (ADR 0004 layer 1,
 * `ledgerVaultExposureGate`): the admission gate before the build reads the
 * ledger, but two deposits admitted a moment apart can each read the same
 * headroom, so the ledger write decides again on what is actually committed.
 * A replay never reaches the hook: a request whose row already exists, or
 * whose same-key twin committed while this write waited for the lock, is
 * answered from that row.
 */
export interface LedgerAdmissionHook {
  admit?: (transaction: DatabaseExecutor) => Promise<void>;
}

/**
 * The per-vault transaction advisory lock every vault DEPOSIT write takes
 * before it re-checks replay and runs the admission hook. Serializes writers
 * to one vault across processes for the life of the transaction; released
 * with the commit or rollback. Same `hashtext(key)` convention as the session
 * locks in `db/client.ts`; a hash collision with another key only adds
 * serialization. Exits never take it (ADR 0002: nothing queues money out).
 */
export function earnVaultDepositWriteLockKey(key: {
  environment: SdpEnvironment;
  provider: string;
  vaultAddress: string;
}): string {
  return `earn:vault-deposit-write:${key.environment}:${key.provider}:${key.vaultAddress}`;
}

async function lockVaultDepositWrites(
  transaction: AppDb,
  key: { environment: SdpEnvironment; provider: string; vaultAddress: string }
): Promise<void> {
  await transaction
    // biome-ignore lint/security/noSecrets: parameterized PostgreSQL function call.
    .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
    .bind(earnVaultDepositWriteLockKey(key))
    .first();
}

/**
 * Share-ATA rent attribution, carried by BOTH money directions.
 *
 * Not deposit-only, and that asymmetry was a bug: an EXIT can create the share
 * account too (consolidation emits an idempotent create, and klend interleaves
 * its own ATA prerequisites into the withdraw bundle), so an exit that paid the
 * rent has to say so or the position keeps naming whoever funded a previous
 * instance of the account.
 */
export interface ShareAccountRentAttribution {
  /**
   * Whether these instructions CREATE the share token account, as OBSERVED by
   * the builder against chain state rather than inferred from the instruction
   * list. Creation is idempotent, so the instruction proves nothing on its own.
   * True is what makes `shareAtaRentFunder` meaningful.
   *
   * Optional, and the default is the safe direction: omitted means "no rent was
   * charged here", so the funder is left untouched and no refund can be
   * misdirected. A caller that cannot observe creation gets the historical
   * behaviour rather than a guess.
   */
  createsShareAccount?: boolean;
  /**
   * Who funds that creation: a sponsor address, or null when the custody wallet
   * pays. Only consulted when `createsShareAccount` is true, and then it is
   * written even if null, so a later entry under a different fee mode cannot
   * inherit the previous one's funder.
   */
  shareAtaRentFunder?: string | null;
}

/** Per-position ledger totals behind the external-wallet earnings read. */
export interface ExternalWalletMovementTotals {
  /** Σ finalized deposits, deposit-token units. */
  finalizedDeposits: string;
  /** Σ observed payouts of finalized withdrawals, deposit-token units. */
  finalizedWithdrawals: string;
  finalizedWithdrawalCount: number;
  /** Finalized withdrawals whose payout was never observed (NULL column). */
  unvaluedWithdrawalCount: number;
  unsettledMovementCount: number;
}

export interface AdvanceVaultMovementInput {
  movementId: string;
  organizationId: string;
  toStatus: string;
  sharesOut?: string | null;
  failureReason?: string | null;
  confirmedAt?: string | null;
  settledAt?: string | null;
  /**
   * Finalizing only. A WITHDRAWAL's observed payout in the position's deposit
   * token; null when it could not be observed. Ignored for deposits, whose
   * token amount is the settled deposit amount and is stamped by the writer.
   */
  tokenAmountSettled?: string | null;
}

export interface CreateSignedVaultWithdrawalIntentInput extends ShareAccountRentAttribution {
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
   * The share mint: the exact quantity the transaction encodes is shares, and
   * tokens received are decided by the chain.
   */
  shareMint: string;
  /** Total caller intent in share units; stored on the withdrawal movement. */
  requestedShares: string;
  /** The custody wallet's public key: shares burn from it, tokens return to it. */
  walletAddress: string;
  signature: string;
  signedTransaction: string;
  lastValidBlockHeight: string;
  requestId: string;
  idempotencyFingerprint: string;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface CreateSignedExternalWalletDepositIntentInput extends LedgerAdmissionHook {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  /** The vault's on-chain address. */
  vaultAddress: string;
  /** The external wallet that signed; SDP holds no key for it. */
  ownerAddress: string;
  shareMint: string;
  tokenMint: string;
  label: string;
  /** Decimal string in the vault token's units, as encoded in the transaction. */
  requestedAmount: string;
  acceptedMinSharesOut?: string | null;
  signature: string;
  signedTransaction: string;
  lastValidBlockHeight: string;
  /** The caller's Idempotency-Key: the movement's org-scoped anchor. */
  requestId: string;
  idempotencyFingerprint: string;
  /** The built transaction being consumed (`earn_external_wallet_transactions.id`). */
  externalWalletTransactionId: string;
  /** The builder's observation that this deposit creates the share account. */
  createsShareAccount?: boolean;
  /**
   * Who funded the share-ATA rent when the build creates the account, carried
   * from the build row: the partner fee payer when one was named (its address
   * was embedded as the provider's rentPayer), otherwise NULL — the 0066/0067
   * convention for "the owner paid its own rent and keeps it". The exit's
   * refund follows this recorded value, never the fee mode of the day.
   */
  shareAtaRentFunder?: string | null;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface CreateSignedExternalWalletWithdrawalIntentInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  /** The EXISTING external-wallet holding being exited; never created here. */
  positionId: string;
  /** Claim facts, FK-verified against the position row on insert. */
  vaultAddress: string;
  ownerAddress: string;
  /** The share mint: the exact quantity the transaction encodes is shares. */
  shareMint: string;
  /** Total caller intent in share units; stored on the withdrawal movement. */
  requestedShares: string;
  signature: string;
  signedTransaction: string;
  lastValidBlockHeight: string;
  requestId: string;
  idempotencyFingerprint: string;
  /** The built transaction being consumed (`earn_external_wallet_transactions.id`). */
  externalWalletTransactionId: string;
  createsShareAccount?: boolean;
  /** Same build-time rent attribution as the deposit intent's field. */
  shareAtaRentFunder?: string | null;
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

/** Mirrors 0062's amount format checks, so app-layer refusals match the DB's. */
const DECIMAL_STRING = /^\d+(?:\.\d+)?$/;
const NON_ZERO_DIGIT = /[1-9]/;

const ATOMIC_VAULT_PROVIDERS_BY_DIRECTION = {
  deposit: Object.entries(EARN_PROVIDER_DEPOSIT_SETTLEMENT)
    .filter(([, settlement]) => settlement === "atomic")
    .map(([provider]) => provider),
  withdrawal: Object.entries(EARN_PROVIDER_WITHDRAWAL_SETTLEMENT)
    .filter(([, settlement]) => settlement === "atomic")
    .map(([provider]) => provider),
} as const satisfies Record<EarnMovementDirection, readonly string[]>;

const ATOMIC_SETTLED_STATUSES_BY_DIRECTION = {
  // The legacy deposit DTO has no finality state and has always stopped at
  // confirmed for atomic providers. Keep that compatibility boundary here.
  deposit: ["confirmed", "finalized"],
  withdrawal: ["finalized"],
} as const satisfies Record<EarnMovementDirection, readonly EarnMovementStatus[]>;

/**
 * Providers whose settlement a chain observation can never complete: the
 * provider strikes and delivers shares later, and until a Connect completion
 * reconciler lands there is NO wire fact that can advance a row past
 * `confirmed` for them. The sweep therefore must not schedule those parked
 * rows (PRO-1593 review): every pass would re-read the same finalized
 * signature and write nothing, forever, with the backlog growing by every
 * successful order. Kept as a static table — the same source the `?settled=`
 * filter and the dashboard read — so a drift test can pin the reconciler's
 * client capability against it. Unknown historical providers stay OUT of this
 * map on purpose: fail-closed keeps them non-terminal and still scheduled,
 * because atomicity is a positive settlement claim and registry drift must
 * never close one of their rows by omission.
 */
const PROVIDER_ORDER_VAULT_PROVIDERS_BY_DIRECTION = {
  deposit: Object.entries(EARN_PROVIDER_DEPOSIT_SETTLEMENT)
    .filter(([, settlement]) => settlement === "provider_order")
    .map(([provider]) => provider),
  withdrawal: Object.entries(EARN_PROVIDER_WITHDRAWAL_SETTLEMENT)
    .filter(([, settlement]) => settlement === "provider_order")
    .map(([provider]) => provider),
} as const satisfies Record<EarnMovementDirection, readonly string[]>;

/**
 * The NOT-parked clause shared by the sweep's claim and its backlog telemetry:
 * a provider-order row at `confirmed` is the strongest fact the wire can
 * express and can never be advanced by another chain read, so it stops being
 * scheduled the moment it parks. Surfacing is a different concern and keeps
 * such a row discoverable (`vaultSettlementFilter` does not use this).
 */
const PARKED_PROVIDER_ORDER_EXCLUSION_SQL = `AND NOT (
                 status = 'confirmed'
                 AND ((direction = 'deposit' AND provider = ANY (?::text[]))
                   OR (direction = 'withdrawal' AND provider = ANY (?::text[])))
               )`;

/**
 * A failed movement is terminal for every provider. Success is terminal only
 * for a provider whose Solana leg is itself atomic. Provider orders (and
 * unknown historical providers) remain discoverable even if a legacy row says
 * finalized; a future authenticated provider reconciler must introduce its
 * own durable completion fact before this predicate can close those rows.
 */
function vaultSettlementFilter(
  direction: EarnMovementDirection,
  settled: boolean | undefined
): { clause: string; values: readonly unknown[] } {
  if (settled === undefined) return { clause: "", values: [] };
  const predicate =
    "(status = 'failed' OR (provider = ANY (?::text[]) AND status = ANY (?::text[])))";
  return {
    clause: settled ? `AND ${predicate}` : `AND NOT ${predicate}`,
    values: [
      [...ATOMIC_VAULT_PROVIDERS_BY_DIRECTION[direction]],
      [...ATOMIC_SETTLED_STATUSES_BY_DIRECTION[direction]],
    ],
  };
}

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
    token_amount_settled: row.token_amount_settled as string | null,
    min_shares_out: row.min_shares_out as string | null,
    shares_out: row.shares_out as string | null,
    payout_token: row.payout_token as string | null,
    custody_wallet_id: row.custody_wallet_id as string | null,
    owner_address: row.owner_address as string | null,
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
    creates_share_account: row.creates_share_account === true,
    share_ata_rent_funder: row.share_ata_rent_funder as string | null,
    unknown_signature_observed_at: row.unknown_signature_observed_at as string | null,
  };
}

const QUEUED_FULFILLMENT_MOVEMENT_PREFIX = "earn_queue_fulfillment_";

/**
 * The ledger id for a fulfilled queued withdrawal's payout movement, shared by
 * the writer (advanceRequest) and the read-side projection so a persisted row
 * and its synthetic fallback can never both appear.
 */
export function queuedFulfillmentMovementId(requestId: string): string {
  return `${QUEUED_FULFILLMENT_MOVEMENT_PREFIX}${requestId}`;
}

function queuedRequestIdFromMovementId(movementId: string): string | null {
  return movementId.startsWith(QUEUED_FULFILLMENT_MOVEMENT_PREFIX)
    ? movementId.slice(QUEUED_FULFILLMENT_MOVEMENT_PREFIX.length)
    : null;
}

function mapFulfilledQueueMovement(row: Record<string, unknown>): EarnMovementRow {
  const requestId = String(row.id);
  const settledAt = String(row.fulfilled_at ?? row.updated_at);
  return {
    id: queuedFulfillmentMovementId(requestId),
    organization_id: String(row.organization_id),
    project_id: row.project_id == null ? null : String(row.project_id),
    environment: row.environment as SdpEnvironment,
    provider: String(row.provider),
    execution_model: "vault_direct",
    direction: "withdrawal",
    position_id: String(row.position_id),
    status: "finalized",
    failure_reason: null,
    confirmed_at: settledAt,
    settled_at: settledAt,
    denomination: String(row.share_mint),
    amount_requested: String(row.shares),
    amount_settled: String(row.shares),
    fee_amount: null,
    token_amount_settled: row.assets_paid == null ? null : String(row.assets_paid),
    min_shares_out: null,
    shares_out: null,
    payout_token: null,
    custody_wallet_id: row.custody_wallet_id == null ? null : String(row.custody_wallet_id),
    owner_address: String(row.owner_address),
    vault_address: String(row.vault_address),
    // Veda's solver is the asset source; the vault is only the instrument and
    // request scope. Until the lifecycle event persists a solver address, SDP
    // has not observed a truthful source address.
    source_address: null,
    destination_address: String(row.owner_address),
    provider_reference: String(row.request_address),
    signature: String(row.closing_signature),
    signed_transaction: null,
    last_valid_block_height: null,
    request_id: String(row.client_request_id),
    idempotency_fingerprint: String(row.idempotency_fingerprint),
    provider_data: {
      observation: "provider_solver_fulfillment",
      withdrawalRequestId: requestId,
      requestAddress: String(row.request_address),
      nonce: row.nonce == null ? null : String(row.nonce),
    },
    created_by: row.created_by == null ? null : String(row.created_by),
    initiated_by_key_id: row.initiated_by_key_id == null ? null : String(row.initiated_by_key_id),
    created_at: settledAt,
    updated_at: String(row.updated_at),
    creates_share_account: false,
    share_ata_rent_funder: null,
    unknown_signature_observed_at: null,
  };
}

function mergeMovementPage(
  ledgerRows: readonly EarnMovementRow[],
  queuedRows: readonly EarnMovementRow[],
  limit: number
): { rows: EarnMovementRow[]; hasMore: boolean } {
  // A fulfilled request whose payout was persisted into earn_movements is
  // also matched by the queued-projection fallback; the ledger row is
  // authoritative and the projection only fills rows that were not persisted.
  const persistedIds = new Set(ledgerRows.map((row) => row.id));
  const combined = [...ledgerRows, ...queuedRows.filter((row) => !persistedIds.has(row.id))].sort(
    (left, right) => {
      if (left.created_at !== right.created_at)
        return right.created_at.localeCompare(left.created_at);
      return right.id.localeCompare(left.id);
    }
  );
  return { rows: combined.slice(0, limit), hasMore: combined.length > limit };
}

async function getFulfilledQueueMovement(
  db: DatabaseExecutor,
  params: { organizationId: string; movementId: string }
): Promise<EarnMovementRow | null> {
  const requestId = queuedRequestIdFromMovementId(params.movementId);
  if (!requestId) return null;
  const row = await db
    .prepare(
      `SELECT * FROM earn_vault_withdrawal_requests
        WHERE id = ? AND organization_id = ? AND status = 'fulfilled'
          AND closing_signature IS NOT NULL`
    )
    .bind(requestId, params.organizationId)
    .first<Record<string, unknown>>();
  return row ? mapFulfilledQueueMovement(row) : null;
}

/**
 * What makes a custody vault claim VISIBLE to the org: the exact predicate
 * behind `GET /vault-positions` (activated, open or re-entered, live movement
 * evidence, wallet-scoped). `listVaultClaimsForReconciliation` shares it by
 * construction, because the reconciliation report's meaning is "relative to
 * what the positions read serves": a claim matched by a broader predicate
 * would mark a holding recorded while `/vault-positions` still hides it, and
 * the Treasury would understate with reconciliation reporting all clear.
 *
 * Binds, in order: organization_id, environment, custody wallet id array.
 */
const CUSTODY_VAULT_CLAIM_VISIBILITY_SQL = `organization_id = ?
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
               )`;

export function createPostgresEarnMovementsRepository(db: AppDb): EarnMovementsRepository {
  return {
    async getMovementById(params) {
      const row = await db
        .prepare(`SELECT * FROM earn_movements WHERE id = ? AND organization_id = ?`)
        .bind(params.movementId, params.organizationId)
        .first<Record<string, unknown>>();
      if (row) return mapMovementRow(row);
      return getFulfilledQueueMovement(db, params);
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
      const settledFilter = vaultSettlementFilter(params.direction, params.settled);
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
               ${settledFilter.clause}
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
          ...settledFilter.values,
          ...beforeValues,
          params.limit + 1
        )
        .all<Record<string, unknown>>();
      const ledgerRows = (result.results ?? []).map(mapMovementRow);
      if (params.direction !== "withdrawal" || params.settled === false) {
        return {
          rows: ledgerRows.slice(0, params.limit),
          hasMore: ledgerRows.length > params.limit,
        };
      }
      const queueBeforeClause = params.before
        ? `AND (COALESCE(fulfilled_at, updated_at),
                    '${QUEUED_FULFILLMENT_MOVEMENT_PREFIX}' || id) < (?, ?)`
        : "";
      const queue = await db
        .prepare(
          `SELECT * FROM earn_vault_withdrawal_requests
            WHERE organization_id = ? AND environment = ? AND project_id = ?
              AND custody_wallet_id = ANY (?::text[])
              AND status = 'fulfilled' AND closing_signature IS NOT NULL
              ${queueBeforeClause}
            ORDER BY COALESCE(fulfilled_at, updated_at) DESC, id DESC
            LIMIT ?`
        )
        .bind(
          params.organizationId,
          params.environment,
          params.projectId,
          params.custodyWalletIds,
          ...(params.before ? [params.before.createdAt, params.before.id] : []),
          params.limit + 1
        )
        .all<Record<string, unknown>>();
      return mergeMovementPage(
        ledgerRows,
        (queue.results ?? []).map(mapFulfilledQueueMovement),
        params.limit
      );
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
             WHERE ${CUSTODY_VAULT_CLAIM_VISIBILITY_SQL}
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

    async listVaultClaimsForReconciliation(params) {
      if (params.custodyWalletIds.length === 0) {
        return [];
      }
      // `has_unsettled_movements` uses the vault ledger's NON-TERMINAL set
      // (finalized|failed are the only terminal statuses). A claim with an
      // in-flight movement is excluded from zero-share reporting by the
      // service: the ledger already explains why chain and record disagree,
      // and the every-minute sweep will settle it either way.
      const result = await db
        .prepare(
          `SELECT *,
                  EXISTS (
                    SELECT 1
                    FROM earn_movements unsettled
                    WHERE unsettled.position_id = earn_positions.id
                      AND unsettled.status IN ('requested', 'submitted', 'confirmed')
                  ) AS has_unsettled_movements
             FROM earn_positions
             WHERE ${CUSTODY_VAULT_CLAIM_VISIBILITY_SQL}
             ORDER BY created_at DESC, id DESC`
        )
        .bind(params.organizationId, params.environment, params.custodyWalletIds)
        .all<EarnPositionRow & { has_unsettled_movements: boolean }>();
      return result.results ?? [];
    },

    async listExternalWalletPositions(params) {
      const beforeClause = params.before ? "AND (created_at, id) < (?, ?)" : "";
      const ownerClause = params.ownerAddress ? "AND owner_address = ?" : "";
      const beforeValues = params.before ? [params.before.createdAt, params.before.id] : [];
      const ownerValues = params.ownerAddress ? [params.ownerAddress] : [];
      const result = await db
        .prepare(
          `SELECT * FROM earn_positions
             WHERE organization_id = ?
               AND project_id = ?
               AND environment = ?
               AND kind = 'vault_direct'
               AND owner_address IS NOT NULL
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
               AND EXISTS (
                 SELECT 1
                 FROM earn_movements movement
                 WHERE movement.position_id = earn_positions.id
                   AND movement.status IN ('requested', 'submitted', 'confirmed', 'finalized')
               )
               ${ownerClause}
               ${beforeClause}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
        )
        .bind(
          params.organizationId,
          params.projectId,
          params.environment,
          ...ownerValues,
          ...beforeValues,
          params.limit + 1
        )
        .all<EarnPositionRow>();
      const rows = result.results ?? [];
      return { rows: rows.slice(0, params.limit), hasMore: rows.length > params.limit };
    },

    async listPositionTokenMints(params) {
      const mints = new Map<string, string>();
      const ids = [...new Set(params.positionIds)];
      if (ids.length === 0) return mints;
      const result = await db
        .prepare(
          `SELECT id, token_mint
             FROM earn_positions
            WHERE organization_id = ?
              AND id = ANY (?::text[])`
        )
        .bind(params.organizationId, ids)
        .all<{ id: string; token_mint: string | null }>();
      for (const row of result.results ?? []) {
        if (row.token_mint) mints.set(row.id, row.token_mint);
      }
      return mints;
    },

    async closeVaultPositionIfEmpty(params) {
      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);
        // Same lock advanceVaultMovement takes: a deposit transition for this
        // holding cannot interleave between the caller's observation and this
        // write, and one that runs after re-opens the row.
        const locked = await transaction
          .prepare(
            `SELECT id FROM earn_positions
              WHERE id = ? AND organization_id = ? AND kind = 'vault_direct'
              FOR UPDATE`
          )
          .bind(params.positionId, params.organizationId)
          .first<{ id: string }>();
        if (!locked) return false;
        // `updated_at = ?` is the snapshot boundary: a deposit transition that
        // landed after the caller observed zero shares bumped it (and cleared
        // closed_at), so the stale observation cannot close the refilled row.
        const closed = await transaction
          .prepare(
            `UPDATE earn_positions
                SET closed_at = sdp_iso_now(), updated_at = sdp_iso_now()
              WHERE id = ? AND organization_id = ? AND closed_at IS NULL
                AND updated_at = ?
                AND NOT EXISTS (
                  SELECT 1 FROM earn_movements unsettled
                   WHERE unsettled.position_id = earn_positions.id
                     AND unsettled.status IN ('requested', 'submitted', 'confirmed')
                )
                -- A queued request escrows shares away from the wallet, so a
                -- perfectly truthful live balance of zero does not mean the
                -- holding is closed. Keep the claim visible until the queue
                -- lifecycle reaches fulfilled/cancelled/failed; cancellation
                -- can restore the wallet balance without creating a movement.
                AND NOT EXISTS (
                  SELECT 1 FROM earn_vault_withdrawal_requests queued
                   WHERE queued.position_id = earn_positions.id
                     AND queued.status IN (
                       'creating', 'pending', 'fulfillable',
                       'expired_cancelable', 'cancelling', 'closed_or_unknown'
                     )
                )
              RETURNING id`
          )
          .bind(params.positionId, params.organizationId, params.observedUpdatedAt)
          .first<{ id: string }>();
        return Boolean(closed);
      });
    },

    async claimUnvaluedWithdrawalPayouts(params) {
      const result = await db
        .prepare(
          `WITH candidates AS MATERIALIZED (
             SELECT id FROM earn_movements
              WHERE execution_model = 'vault_direct'
                AND direction = 'withdrawal'
                AND status = 'finalized'
                AND token_amount_settled IS NULL
                AND signature IS NOT NULL
                AND settled_at >= ?
                AND (reconciliation_attempted_at IS NULL OR reconciliation_attempted_at <= ?)
              ORDER BY COALESCE(reconciliation_attempted_at, settled_at) ASC, id ASC
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           ), touched AS (
             UPDATE earn_movements movement
                SET reconciliation_attempted_at = sdp_iso_now()
               FROM candidates
              WHERE movement.id = candidates.id
             RETURNING movement.*
           )
           SELECT * FROM touched ORDER BY settled_at ASC, id ASC`
        )
        .bind(params.settledAfter, params.retryBefore, params.limit)
        .all<Record<string, unknown>>();
      return (result.results ?? []).map(mapMovementRow);
    },

    async recordWithdrawalPayout(params) {
      const row = await db
        .prepare(
          `UPDATE earn_movements
              SET token_amount_settled = ?, updated_at = sdp_iso_now()
            WHERE id = ? AND organization_id = ?
              AND execution_model = 'vault_direct'
              AND direction = 'withdrawal'
              AND status = 'finalized'
              AND token_amount_settled IS NULL
            RETURNING id`
        )
        .bind(params.tokenAmountSettled, params.movementId, params.organizationId)
        .first<{ id: string }>();
      return Boolean(row);
    },

    async listExternalWalletDepositsSince(params) {
      // idx_earn_movements_external_wallet_owner drives the range scan; the
      // direction/denomination predicates filter on the heap.
      const result = await db
        .prepare(
          `SELECT * FROM earn_movements
            WHERE organization_id = ?
              AND project_id IS NOT DISTINCT FROM ?
              AND environment = ?
              AND owner_address = ?
              AND direction = 'deposit'
              AND denomination = ?
              AND created_at > ?
            ORDER BY created_at ASC, id ASC`
        )
        .bind(
          params.organizationId,
          params.projectId,
          params.environment,
          params.ownerAddress,
          params.depositTokenMint,
          params.createdAfter
        )
        .all<Record<string, unknown>>();
      return (result.results ?? []).map(mapMovementRow);
    },

    async listExternalWalletMovements(params) {
      const conditions = [
        "organization_id = ?",
        "project_id = ?",
        "environment = ?",
        "owner_address = ?",
      ];
      const bindings: unknown[] = [
        params.organizationId,
        params.projectId,
        params.environment,
        params.ownerAddress,
      ];
      for (const [column, value] of [
        ["direction", params.direction],
        ["status", params.status],
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
      const ledgerRows = (result.results ?? []).map(mapMovementRow);
      if (
        (params.direction !== undefined && params.direction !== "withdrawal") ||
        (params.status !== undefined && params.status !== "finalized")
      ) {
        return {
          rows: ledgerRows.slice(0, params.limit),
          hasMore: ledgerRows.length > params.limit,
        };
      }
      const queueBeforeClause = params.before
        ? `AND (COALESCE(fulfilled_at, updated_at),
                    '${QUEUED_FULFILLMENT_MOVEMENT_PREFIX}' || id) < (?, ?)`
        : "";
      const queue = await db
        .prepare(
          `SELECT * FROM earn_vault_withdrawal_requests
            WHERE organization_id = ? AND project_id = ? AND environment = ?
              AND owner_address = ? AND custody_wallet_id IS NULL
              AND status = 'fulfilled' AND closing_signature IS NOT NULL
              ${queueBeforeClause}
            ORDER BY COALESCE(fulfilled_at, updated_at) DESC, id DESC
            LIMIT ?`
        )
        .bind(
          params.organizationId,
          params.projectId,
          params.environment,
          params.ownerAddress,
          ...(params.before ? [params.before.createdAt, params.before.id] : []),
          params.limit + 1
        )
        .all<Record<string, unknown>>();
      return mergeMovementPage(
        ledgerRows,
        (queue.results ?? []).map(mapFulfilledQueueMovement),
        params.limit
      );
    },

    async getExternalWalletMovement(params) {
      // owner_address IS NOT NULL is the shape half of the scope: a custody
      // movement guessed by id answers exactly like a missing row.
      const row = await db
        .prepare(
          `SELECT * FROM earn_movements
             WHERE id = ?
               AND organization_id = ?
               AND project_id = ?
               AND environment = ?
               AND owner_address IS NOT NULL`
        )
        .bind(params.movementId, params.organizationId, params.projectId, params.environment)
        .first<Record<string, unknown>>();
      if (row) return mapMovementRow(row);
      const projected = await getFulfilledQueueMovement(db, {
        organizationId: params.organizationId,
        movementId: params.movementId,
      });
      return projected &&
        projected.project_id === params.projectId &&
        projected.environment === params.environment &&
        projected.owner_address !== null &&
        projected.custody_wallet_id === null
        ? projected
        : null;
    },

    async aggregateExternalWalletMovements(params) {
      // Postgres numeric is exact, and every summed row shares its position's
      // deposit-token denomination, so the casts lose nothing. `COALESCE` on
      // amount_settled is belt and braces: the writer stamps it on every
      // finalized row. Withdrawals sum `token_amount_settled` (0103), the
      // observed payout; a finalized withdrawal with none is counted so the
      // read can withhold earned instead of understating it.
      const result = await db
        .prepare(
          `WITH facts AS (
             SELECT position_id,
                    CASE WHEN direction = 'deposit' AND status = 'finalized'
                         THEN COALESCE(amount_settled, amount_requested)::numeric
                         ELSE 0::numeric END AS finalized_deposits,
                    CASE WHEN direction = 'withdrawal' AND status = 'finalized'
                         THEN COALESCE(token_amount_settled, '0')::numeric
                         ELSE 0::numeric END AS finalized_withdrawals,
                    CASE WHEN direction = 'withdrawal' AND status = 'finalized'
                         THEN 1 ELSE 0 END AS finalized_withdrawal_count,
                    CASE WHEN direction = 'withdrawal' AND status = 'finalized'
                               AND token_amount_settled IS NULL
                         THEN 1 ELSE 0 END AS unvalued_withdrawal_count,
                    CASE WHEN status IN ('requested', 'submitted', 'confirmed')
                         THEN 1 ELSE 0 END AS unsettled_movement_count
               FROM earn_movements
              WHERE organization_id = ?
                AND project_id = ?
                AND environment = ?
                AND owner_address = ?
              UNION ALL
              SELECT request.position_id,
                     0::numeric,
                     CASE WHEN request.status = 'fulfilled'
                          THEN COALESCE(request.assets_paid, '0')::numeric
                          ELSE 0::numeric END,
                     CASE WHEN request.status = 'fulfilled' THEN 1 ELSE 0 END,
                     CASE WHEN request.status = 'fulfilled' AND request.assets_paid IS NULL
                          THEN 1 ELSE 0 END,
                     CASE WHEN request.status IN (
                            'creating', 'pending', 'fulfillable',
                            'expired_cancelable', 'cancelling', 'closed_or_unknown'
                          ) THEN 1 ELSE 0 END
                FROM earn_vault_withdrawal_requests request
               WHERE request.organization_id = ?
                 AND request.project_id = ?
                 AND request.environment = ?
                 AND request.owner_address = ?
                 AND request.custody_wallet_id IS NULL
                 -- A fulfilled request whose payout was persisted into
                 -- earn_movements is already counted by the ledger half of this
                 -- union; counting the queue projection too would double the
                 -- withdrawal and its payout. The prefix is the one the writer
                 -- (advanceRequest) keys the movement on.
                 AND NOT EXISTS (
                   SELECT 1 FROM earn_movements persisted
                    WHERE persisted.id =
                      '${QUEUED_FULFILLMENT_MOVEMENT_PREFIX}' || request.id
                 )
            )
           SELECT position_id,
                  COALESCE(SUM(finalized_deposits), 0)::text AS finalized_deposits,
                  COALESCE(SUM(finalized_withdrawals), 0)::text AS finalized_withdrawals,
                  COALESCE(SUM(finalized_withdrawal_count), 0) AS finalized_withdrawal_count,
                  COALESCE(SUM(unvalued_withdrawal_count), 0) AS unvalued_withdrawal_count,
                  COALESCE(SUM(unsettled_movement_count), 0) AS unsettled_movement_count
             FROM facts
            GROUP BY position_id`
        )
        .bind(
          params.organizationId,
          params.projectId,
          params.environment,
          params.ownerAddress,
          params.organizationId,
          params.projectId,
          params.environment,
          params.ownerAddress
        )
        .all<{
          position_id: string;
          finalized_deposits: string;
          finalized_withdrawals: string;
          finalized_withdrawal_count: number;
          unvalued_withdrawal_count: number;
          unsettled_movement_count: number;
        }>();
      const totals = new Map<string, ExternalWalletMovementTotals>();
      for (const row of result.results ?? []) {
        totals.set(row.position_id, {
          finalizedDeposits: row.finalized_deposits,
          finalizedWithdrawals: row.finalized_withdrawals,
          finalizedWithdrawalCount: Number(row.finalized_withdrawal_count),
          unvaluedWithdrawalCount: Number(row.unvalued_withdrawal_count),
          unsettledMovementCount: Number(row.unsettled_movement_count),
        });
      }
      return totals;
    },

    async sumVaultDepositExposure(params) {
      // One definition of SDP-wide exposure, in SQL (migration 0101): the
      // function widens its own read to the system isolation identity for the
      // duration of the aggregate, so the same figure comes back whether the
      // caller is the admission gate on a pooled connection or the ledger
      // write inside a tenant-stamped transaction. Postgres numeric is exact
      // and every summed row shares the vault's deposit-token denomination, so
      // the text rendering loses nothing. Served by
      // idx_earn_movements_vault_exposure (migration 0100).
      const row = await db
        .prepare(`SELECT earn_vault_deposit_exposure(?, ?, ?)::text AS exposure`)
        .bind(params.environment, params.provider, params.vaultAddress)
        .first<{ exposure: string }>();
      return row?.exposure ?? "0";
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
      const ledgerRows = (result.results ?? []).map(mapMovementRow);
      if (
        params.custodyWalletIds.length === 0 ||
        (params.direction !== undefined && params.direction !== "withdrawal") ||
        (params.status !== undefined && params.status !== "finalized") ||
        // The solver source is not persisted, so a source-address filter can
        // never truthfully match a queued fulfillment projection.
        params.sourceAddress !== undefined
      ) {
        return {
          rows: ledgerRows.slice(0, params.limit),
          hasMore: ledgerRows.length > params.limit,
        };
      }
      const queueConditions = [
        "organization_id = ?",
        "environment = ?",
        "project_id = ?",
        "custody_wallet_id = ANY (?::text[])",
        "status = 'fulfilled'",
        "closing_signature IS NOT NULL",
      ];
      const queueBindings: unknown[] = [
        params.organizationId,
        params.environment,
        params.projectId,
        params.custodyWalletIds,
      ];
      for (const [column, value] of [
        ["provider", params.provider],
        ["position_id", params.positionId],
        ["owner_address", params.destinationAddress],
      ] as const) {
        if (value !== undefined) {
          queueConditions.push(`${column} = ?`);
          queueBindings.push(value);
        }
      }
      if (params.before) {
        queueConditions.push(
          `(COALESCE(fulfilled_at, updated_at),
            '${QUEUED_FULFILLMENT_MOVEMENT_PREFIX}' || id) < (?, ?)`
        );
        queueBindings.push(params.before.createdAt, params.before.id);
      }
      const queue = await db
        .prepare(
          `SELECT * FROM earn_vault_withdrawal_requests
            WHERE ${queueConditions.join(" AND ")}
            ORDER BY COALESCE(fulfilled_at, updated_at) DESC, id DESC
            LIMIT ?`
        )
        .bind(...queueBindings, params.limit + 1)
        .all<Record<string, unknown>>();
      return mergeMovementPage(
        ledgerRows,
        (queue.results ?? []).map(mapFulfilledQueueMovement),
        params.limit
      );
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
      // The one exception is a provider-order row already parked at `confirmed`
      // (the exclusion clause below): no chain read can ever advance it, so
      // re-claiming it would only re-observe the same finalized signature and
      // write nothing, on every tick, forever. It keeps its awaiting-provider
      // surface through `vaultSettlementFilter`; the sweep just stops paying
      // for it. Unknown historical providers fail closed and stay scheduled.
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
                ${PARKED_PROVIDER_ORDER_EXCLUSION_SQL}
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
                ${PARKED_PROVIDER_ORDER_EXCLUSION_SQL}
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
        .bind(
          blockhashBoundQuota,
          [...PROVIDER_ORDER_VAULT_PROVIDERS_BY_DIRECTION.deposit],
          [...PROVIDER_ORDER_VAULT_PROVIDERS_BY_DIRECTION.withdrawal],
          confirmedQuota,
          [...PROVIDER_ORDER_VAULT_PROVIDERS_BY_DIRECTION.deposit],
          [...PROVIDER_ORDER_VAULT_PROVIDERS_BY_DIRECTION.withdrawal],
          limit
        )
        .all<Record<string, unknown>>();
      return (result.results ?? []).map(mapMovementRow);
    },

    async getUnsettledVaultMovementStats() {
      // Keep this predicate in lockstep with claimUnsettledVaultMovements: the
      // backlog it reports must be the same set the sweep would claim. Bound by
      // the "reports exactly the rows the next claim would take" test in
      // services/jobs/reconcile-earn-vault-movements.test.ts, which seeds one
      // row in every reachable status and asserts this count against the
      // claimed id SET rather than a literal, so the two fail together instead
      // of drifting silently.
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS backlog,
                  COUNT(*) FILTER (WHERE status IN ('requested', 'submitted')) AS backlog_blockhash_bound,
                  COUNT(*) FILTER (WHERE status = 'confirmed') AS backlog_confirmed,
                  COUNT(*) FILTER (WHERE direction = 'withdrawal') AS backlog_withdrawals,
                  MIN(created_at) AS oldest_created_at,
                  MIN(created_at) FILTER (WHERE status IN ('requested', 'submitted'))
                    AS oldest_blockhash_bound_created_at,
                  MIN(created_at) FILTER (WHERE direction = 'withdrawal')
                    AS oldest_withdrawal_created_at
             FROM earn_movements
            WHERE execution_model = 'vault_direct'
              AND status IN ('requested', 'submitted', 'confirmed')
              ${PARKED_PROVIDER_ORDER_EXCLUSION_SQL}`
        )
        .bind(
          [...PROVIDER_ORDER_VAULT_PROVIDERS_BY_DIRECTION.deposit],
          [...PROVIDER_ORDER_VAULT_PROVIDERS_BY_DIRECTION.withdrawal]
        )
        .first<{
          backlog: number | string;
          backlog_blockhash_bound: number | string;
          backlog_confirmed: number | string;
          backlog_withdrawals: number | string;
          oldest_created_at: string | null;
          oldest_blockhash_bound_created_at: string | null;
          oldest_withdrawal_created_at: string | null;
        }>();
      return {
        backlog: Number(row?.backlog ?? 0),
        backlogBlockhashBound: Number(row?.backlog_blockhash_bound ?? 0),
        backlogConfirmed: Number(row?.backlog_confirmed ?? 0),
        backlogWithdrawals: Number(row?.backlog_withdrawals ?? 0),
        oldestUnsettledCreatedAt: row?.oldest_created_at ?? null,
        oldestBlockhashBoundCreatedAt: row?.oldest_blockhash_bound_created_at ?? null,
        oldestWithdrawalCreatedAt: row?.oldest_withdrawal_created_at ?? null,
      };
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

        // Serialize writers to this vault, then ask the replay question AGAIN
        // under the lock: a same-key twin that committed while this write
        // waited is this deposit already recorded, and must be answered as
        // the replay it is, never refused by the admission hook below. Nothing
        // upstream serializes same-key duplicates, so this is where they meet.
        await lockVaultDepositWrites(transaction, input);
        const twin = await findVaultMovementByRequest(
          transaction,
          input.organizationId,
          input.requestId
        );
        if (twin) {
          assertMovementIsOwnReplay(twin, input);
          return {
            position: await requireMovementPosition(transaction, twin),
            movement: twin,
            replayed: true,
          };
        }

        // Platform admission, decided on committed rows under the vault lock,
        // before anything is claimed. See `LedgerAdmissionHook`.
        await input.admit?.(executor);

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

        // AFTER the insert, because the projection reads the row the insert
        // just wrote. A loser never reaches here, and would change nothing if it
        // did: it has no movement row to project from.
        await projectShareAccountRentFunder(transaction, claimed.id, input.organizationId);

        return { position: claimed, movement: inserted, replayed: false };
      });
    },

    async createSignedVaultWithdrawalIntent(input) {
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
            replayed: true,
          };
        };

        const prior = await resolveReplay();
        if (prior) return prior;

        const movement = await insertVaultWithdrawalMovement(transaction, input);
        if (!movement) {
          // A concurrent identical request committed after the preflight. Its
          // signed transaction, not ours, is the one that may be broadcast.
          const winner = await resolveReplay();
          if (!winner) throw new Error("Failed to resolve concurrent earn vault withdrawal");
          return winner;
        }

        // An exit that creates the share account funds its rent too, so it
        // joins the same projection. Same ordering reason as the deposit above.
        await projectShareAccountRentFunder(
          transaction,
          movement.position_id,
          input.organizationId
        );
        return {
          position: await requireMovementPosition(transaction, movement),
          movement,
          replayed: false,
        };
      });
    },

    async createSignedExternalWalletDepositIntent(input) {
      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);

        const resolved = await resolveExternalWalletTransactionConsumption(
          transaction,
          input,
          "deposit"
        );
        if (resolved) {
          return {
            position: await requireMovementPosition(transaction, resolved.movement),
            movement: resolved.movement,
            replayed: true,
          };
        }

        // The built-transaction row lock above serializes same-BUILD racers;
        // a same-KEY racer for a DIFFERENT build holds a different row lock,
        // so the request key is asked again under the vault lock, exactly as
        // the custody path does: a twin that committed while this write
        // waited is answered as its replay, and a divergent one is the
        // idempotency conflict, never a cap refusal from the hook below. The
        // vault lock is taken AFTER the row lock on purpose: the custody path
        // takes the vault lock first and never the row lock, so no cycle.
        await lockVaultDepositWrites(transaction, input);
        const twin = await findVaultMovementByRequest(
          transaction,
          input.organizationId,
          input.requestId
        );
        if (twin) {
          assertMovementIsOwnReplay(twin, input);
          return {
            position: await requireMovementPosition(transaction, twin),
            movement: twin,
            replayed: true,
          };
        }

        await input.admit?.(executor);

        const claimed = await claimExternalWalletVaultPosition(transaction, input);
        const inserted = await insertExternalWalletDepositMovement(transaction, input, claimed.id);
        if (!inserted) {
          // The built-transaction lock serializes same-build racers, so a loser
          // here reused its KEY against a different build and lost to it; the
          // fingerprint (which names the build) decides replay versus conflict.
          const winner = await findVaultMovementByRequest(
            transaction,
            input.organizationId,
            input.requestId
          );
          if (!winner)
            throw new Error("Failed to resolve concurrent earn external-wallet movement");
          assertMovementIsOwnReplay(winner, input);
          return {
            position: await requireMovementPosition(transaction, winner),
            movement: winner,
            replayed: true,
          };
        }

        await consumeExternalWalletTransaction(
          transaction,
          input.externalWalletTransactionId,
          inserted.id
        );
        // AFTER the insert, because the projection reads the row the insert
        // just wrote (same ordering rule as the custody deposit above).
        await projectShareAccountRentFunder(transaction, claimed.id, input.organizationId);

        return { position: claimed, movement: inserted, replayed: false };
      });
    },

    async createSignedExternalWalletWithdrawalIntent(input) {
      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);

        const resolved = await resolveExternalWalletTransactionConsumption(
          transaction,
          input,
          "withdrawal"
        );
        if (resolved) {
          return {
            position: await requireMovementPosition(transaction, resolved.movement),
            movement: resolved.movement,
            replayed: true,
          };
        }

        const movement = await insertExternalWalletWithdrawalMovement(transaction, input);
        if (!movement) {
          const winner = await findVaultMovementByRequest(
            transaction,
            input.organizationId,
            input.requestId
          );
          if (!winner) {
            throw new Error("Failed to resolve concurrent earn external-wallet withdrawal");
          }
          assertMovementIsOwnReplay(winner, input);
          return {
            position: await requireMovementPosition(transaction, winner),
            movement: winner,
            replayed: true,
          };
        }

        await consumeExternalWalletTransaction(
          transaction,
          input.externalWalletTransactionId,
          movement.id
        );
        // An exit that creates the share account claims its rent attribution
        // too, exactly like the custody exit.
        await projectShareAccountRentFunder(
          transaction,
          movement.position_id,
          input.organizationId
        );

        return {
          position: await requireMovementPosition(transaction, movement),
          movement,
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
      if (input.toStatus === "finalized") {
        // The deposit-token view of the same settlement (0103). A deposit's
        // token amount IS its settled amount; a withdrawal's is whatever the
        // caller observed on the landed transaction, or NULL when it could
        // not. SET expressions read the pre-update row, so the COALESCE over
        // amount_settled resolves exactly as the assignment above does.
        assignments.push(
          `token_amount_settled = COALESCE(
             token_amount_settled,
             CASE WHEN direction = 'deposit' THEN COALESCE(amount_settled, amount_requested)
                  ELSE ? END
           )`
        );
        values.push(input.tokenAmountSettled ?? null);
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
          // A failed movement charged no rent: an expired transaction never
          // executed, and one that failed on chain had every effect reverted.
          // Re-projecting drops its claim and hands the attribution back to the
          // previous surviving claimant, so a close cannot refund a party whose
          // transaction did not land. Without this the stale claim outlives the
          // movement for as long as the position does.
          await projectShareAccountRentFunder(
            transaction,
            movement.position_id,
            input.organizationId
          );
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

    async recordUnknownSignatureObservation(input) {
      const row = await db
        .prepare(
          `UPDATE earn_movements
              SET unknown_signature_observed_at = COALESCE(unknown_signature_observed_at, sdp_iso_now()),
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND organization_id = ?
              AND execution_model = 'vault_direct'
              AND status = 'submitted'
            RETURNING *`
        )
        .bind(input.movementId, input.organizationId)
        .first<Record<string, unknown>>();
      return row ? mapMovementRow(row) : null;
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
  if (input.tokenAmountSettled !== undefined && input.toStatus !== "finalized") {
    throw new Error("tokenAmountSettled is only valid when finalizing an earn vault movement");
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

/**
 * One withdrawal movement, inserted before its signed bytes are broadcast.
 *
 * The two composite FKs onto `earn_positions` are the claim check: a movement whose
 * (position, organization, environment, provider, vault, wallet) tuple does not
 * exactly match the holding fails the INSERT rather than recording money
 * against someone else's claim. Denomination is the SHARE MINT and
 * `amount_requested` is the exact shares the transaction encodes.
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
         signature, signed_transaction, last_valid_block_height,
         request_id, idempotency_fingerprint,
         created_by, initiated_by_key_id,
         creates_share_account, share_ata_rent_funder
       ) VALUES (?, ?, ?, ?, ?, 'vault_direct', 'withdrawal', ?, 'requested',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.signature,
      input.signedTransaction,
      input.lastValidBlockHeight,
      input.requestId,
      input.idempotencyFingerprint,
      input.createdBy ?? null,
      input.initiatedByKeyId ?? null,
      ...shareAccountClaimBindings(input)
    )
    .first<Record<string, unknown>>();
  return row ? mapMovementRow(row) : null;
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
/**
 * The two claim columns every vault movement insert binds, in column order.
 *
 * A movement that did not create the share account records no funder, which the
 * 0067 CHECK also enforces: a refund destination for rent that was never charged
 * is not a weaker claim, it is a false one.
 */
function shareAccountClaimBindings(input: ShareAccountRentAttribution): [boolean, string | null] {
  const creates = input.createsShareAccount === true;
  return [creates, creates ? (input.shareAtaRentFunder ?? null) : null];
}

/**
 * Recompute `earn_positions.share_ata_rent_funder` from the movements that
 * claimed to create the share account (migration 0067).
 *
 * DERIVED, not remembered, and that is the whole design. The claim is written on
 * the movement inside the pre-broadcast intent transaction, so it is a statement
 * about a transaction that has not landed yet. Three failures fall out of
 * projecting instead of assigning:
 *
 *   * a movement that never lands is FAILED by reconciliation and drops out
 *     here, handing the attribution back to the previous surviving claimant
 *     instead of naming a party that paid nothing for as long as the position
 *     lives;
 *   * a movement that lost its idempotency insert has no row, so it cannot
 *     contribute at all, whatever fee mode it had resolved;
 *   * a rolled-back intent takes its claim with it.
 *
 * Newest claimant wins, matching "the account is created at most once and the
 * last creation is the live one". Callers hold the position row lock already:
 * both intent creators take it through their claim upsert or their own
 * transaction, and `advanceVaultMovement` takes it explicitly.
 *
 * ── The confirmed-fork tail, and why excluding only `failed` is enough ─────
 * A claimant that reached `confirmed` and was then dropped by a fork can never
 * be failed (the transition matrix forbids `confirmed -> failed` on purpose;
 * see @sdp/types EARN_MOVEMENT_TRANSITIONS), so its claim stays selected here.
 * That inherits the ledger's own accepted open question rather than adding a
 * new reachable loss: the dropped create never landed, so the account is still
 * missing, and an exit only reads this projection when the account EXISTS at
 * its build (an exit that creates the account refunds its own rent payer and
 * ignores the projection). Whoever re-created it was either a later SDP
 * movement, whose newer claim supersedes the stale one, or an external actor,
 * which is the already-documented external-create residual, reachable with or
 * without any fork. Confirming the funder from the LANDED transaction at
 * settlement closes both and is deliberately not attempted here.
 */
async function projectShareAccountRentFunder(
  db: AppDb,
  positionId: string,
  organizationId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE earn_positions position
          SET share_ata_rent_funder = (
                SELECT movement.share_ata_rent_funder
                  FROM earn_movements movement
                 WHERE movement.position_id = position.id
                   AND movement.creates_share_account
                   AND movement.status <> 'failed'
                 ORDER BY movement.created_at DESC, movement.id DESC
                 LIMIT 1
              ),
              updated_at = sdp_iso_now()
        WHERE position.id = ? AND position.organization_id = ?`
    )
    .bind(positionId, organizationId)
    .run();
}

/**
 * Lock the built external-wallet transaction named by a submit, and resolve the
 * submit's idempotency outcome UNDER that lock (PRO-1722).
 *
 * The lock ordering is the safety argument: one built transaction can land on
 * chain at most once, and its signature is globally unique in the ledger, so
 * two submits racing the same build have to serialize BEFORE either inserts a
 * movement. The loser then observes either its own key's recorded movement (a
 * replay) or a row consumed under someone else's key (a clean conflict), never
 * a unique-violation on the signature index surfaced as a 500.
 *
 * Returns the movement to replay, or null when the caller should insert.
 */
async function resolveExternalWalletTransactionConsumption(
  db: AppDb,
  input: {
    organizationId: string;
    projectId: string;
    requestId: string;
    idempotencyFingerprint: string;
    externalWalletTransactionId: string;
  },
  direction: EarnMovementDirection
): Promise<{ movement: EarnMovementRow } | null> {
  const built = await db
    .prepare(
      `SELECT id, movement_id FROM earn_external_wallet_transactions
        WHERE id = ? AND organization_id = ?
        FOR UPDATE`
    )
    .bind(input.externalWalletTransactionId, input.organizationId)
    .first<{ id: string; movement_id: string | null }>();
  if (!built) {
    // The service resolves the built row before it calls in, so a miss here is
    // a broken invariant, not caller error.
    throw new Error(
      `Earn external-wallet submit references missing built transaction ${input.externalWalletTransactionId}`
    );
  }

  const prior = await findVaultMovementByRequest(db, input.organizationId, input.requestId);
  if (prior) {
    assertMovementIsOwnReplay(prior, input);
    if (prior.direction !== direction) {
      throw conflict("Idempotency key already used with different request payload");
    }
    return { movement: prior };
  }

  if (built.movement_id !== null) {
    // A DIFFERENT key already consumed this build. Answering it as a replay
    // would hand one caller intent another intent's movement; a second
    // movement would be the same transaction ledgered twice.
    throw conflict("This transaction was already submitted under a different idempotency key");
  }
  return null;
}

/** Mark the built transaction consumed by the movement the caller just inserted. */
async function consumeExternalWalletTransaction(
  db: AppDb,
  externalWalletTransactionId: string,
  movementId: string
): Promise<void> {
  const consumed = await db
    .prepare(
      `UPDATE earn_external_wallet_transactions
          SET movement_id = ?, consumed_at = sdp_iso_now(), updated_at = sdp_iso_now()
        WHERE id = ? AND movement_id IS NULL
        RETURNING id`
    )
    .bind(movementId, externalWalletTransactionId)
    .first<{ id: string }>();
  if (!consumed) {
    // Unreachable while the FOR UPDATE lock above serializes consumers; failing
    // loudly rolls the movement back rather than double-ledgering the build.
    throw new Error(
      `Earn external-wallet built transaction ${externalWalletTransactionId} was consumed concurrently`
    );
  }
}

/**
 * Claim or refresh the EXTERNAL-WALLET vault holding: one per (org, project,
 * environment, provider, vault, owner). Tenancy comes FROM the project row
 * rather than from the input, like the custody claim below; there is no wallet
 * scope to validate because SDP holds nothing here — the owner address IS the
 * holder. A mint-identity mismatch returns nothing and answers 409.
 */
async function claimExternalWalletVaultPosition(
  db: AppDb,
  input: CreateSignedExternalWalletDepositIntentInput
): Promise<EarnPositionRow> {
  const row = await db
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         owner_address, vault_address, share_mint, token_mint, label,
         created_by, activated_at
       )
       SELECT
         ?, project.organization_id, project.id, project.environment,
         ?, 'vault_direct', ?, ?, ?, ?, ?, ?, sdp_iso_now()
       FROM projects project
       WHERE project.id = ?
         AND project.organization_id = ?
         AND project.environment = ?
       ON CONFLICT (organization_id, project_id, environment, provider, vault_address, owner_address)
         WHERE kind = 'vault_direct' AND owner_address IS NOT NULL
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
      input.ownerAddress,
      input.vaultAddress,
      input.shareMint,
      input.tokenMint,
      input.label,
      input.createdBy ?? null,
      input.projectId,
      input.organizationId,
      input.environment
    )
    .first<EarnPositionRow>();
  if (!row) {
    throw conflict("Vault position does not match project scope or asset identity");
  }
  return row;
}

async function insertExternalWalletDepositMovement(
  db: AppDb,
  input: CreateSignedExternalWalletDepositIntentInput,
  positionId: string
): Promise<EarnMovementRow | null> {
  const row = await db
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id, status,
         denomination, amount_requested, min_shares_out,
         owner_address, vault_address, source_address, destination_address,
         signature, signed_transaction, last_valid_block_height,
         request_id, idempotency_fingerprint, created_by, initiated_by_key_id,
         creates_share_account, share_ata_rent_funder
       ) VALUES (?, ?, ?, ?, ?, 'vault_direct', 'deposit', ?, 'requested',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.ownerAddress,
      input.vaultAddress,
      // The external wallet funds the deposit; the instrument receives it.
      input.ownerAddress,
      input.vaultAddress,
      input.signature,
      input.signedTransaction,
      input.lastValidBlockHeight,
      input.requestId,
      input.idempotencyFingerprint,
      input.createdBy ?? null,
      input.initiatedByKeyId ?? null,
      // Rent attribution recorded at build time (0066/0067 convention): NULL
      // means the owner paid its own rent and the exit's refund defaults back
      // to the owner; a partner fee payer that funded the share ATA is named
      // so the exit refunds the partner, never the owner.
      ...shareAccountClaimBindings({
        createsShareAccount: input.createsShareAccount,
        shareAtaRentFunder: input.shareAtaRentFunder ?? null,
      })
    )
    .first<Record<string, unknown>>();
  return row ? mapMovementRow(row) : null;
}

async function insertExternalWalletWithdrawalMovement(
  db: AppDb,
  input: CreateSignedExternalWalletWithdrawalIntentInput
): Promise<EarnMovementRow | null> {
  const row = await db
    .prepare(
      `INSERT INTO earn_movements (
         id, organization_id, project_id, environment, provider,
         execution_model, direction, position_id, status,
         denomination, amount_requested,
         owner_address, vault_address, source_address, destination_address,
         signature, signed_transaction, last_valid_block_height,
         request_id, idempotency_fingerprint, created_by, initiated_by_key_id,
         creates_share_account, share_ata_rent_funder
       ) VALUES (?, ?, ?, ?, ?, 'vault_direct', 'withdrawal', ?, 'requested',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.ownerAddress,
      input.vaultAddress,
      // Money leaves the INSTRUMENT and returns to the external wallet.
      input.vaultAddress,
      input.ownerAddress,
      input.signature,
      input.signedTransaction,
      input.lastValidBlockHeight,
      input.requestId,
      input.idempotencyFingerprint,
      input.createdBy ?? null,
      input.initiatedByKeyId ?? null,
      // Same build-time rent attribution rule as the deposit insert above: an
      // exit consolidation that creates the account may be partner-funded.
      ...shareAccountClaimBindings({
        createsShareAccount: input.createsShareAccount,
        shareAtaRentFunder: input.shareAtaRentFunder ?? null,
      })
    )
    .first<Record<string, unknown>>();
  return row ? mapMovementRow(row) : null;
}

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
         request_id, idempotency_fingerprint, created_by, initiated_by_key_id,
         creates_share_account, share_ata_rent_funder
       ) VALUES (?, ?, ?, ?, ?, 'vault_direct', 'deposit', ?, 'requested',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.initiatedByKeyId ?? null,
      ...shareAccountClaimBindings(input)
    )
    .first<Record<string, unknown>>();
  return row ? mapMovementRow(row) : null;
}

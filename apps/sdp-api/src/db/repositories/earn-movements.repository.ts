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
  /** External-wallet vault claims, exact-project scoped, newest first. */
  listExternalWalletPositions(params: {
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    ownerAddress?: string;
    limit: number;
    before: EarnMovementCursor | null;
  }): Promise<{ rows: EarnPositionRow[]; hasMore: boolean }>;
  /** Whether this exact partner project has ever claimed a position for the owner. */
  hasExternalWalletPositionOwner(params: {
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    ownerAddress: string;
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
  /** One external-wallet movement under the same four scoping rules, or null. */
  getExternalWalletMovement(params: {
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    movementId: string;
  }): Promise<EarnMovementRow | null>;
  /**
   * Ledger inputs to the per-owner earnings figure, grouped by position
   * (PRO-1772): finalized deposit total (deposit-token units — deposits all
   * share their position's token denomination, so the SUM never crosses
   * denominations), finalized withdrawal count, and how many movements are
   * still unsettled. Failed movements are ignored — that money never moved.
   */
  aggregateExternalWalletMovements(params: {
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment;
    ownerAddress: string;
  }): Promise<
    Map<
      string,
      {
        finalizedDeposits: string;
        finalizedWithdrawalCount: number;
        unsettledMovementCount: number;
      }
    >
  >;
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

export interface CreateSignedVaultDepositIntentInput extends ShareAccountRentAttribution {
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

export interface AdvanceVaultMovementInput {
  movementId: string;
  organizationId: string;
  toStatus: string;
  sharesOut?: string | null;
  failureReason?: string | null;
  confirmedAt?: string | null;
  settledAt?: string | null;
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

export interface CreateSignedExternalWalletDepositIntentInput {
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
  /**
   * The builder's observation that this deposit creates the share account. The
   * funder is always recorded as the owner (NULL by the 0066/0067 convention:
   * the signing wallet paid its own rent and keeps it), so the exit's refund
   * defaults back to the owner with no attribution to carry.
   */
  createsShareAccount?: boolean;
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

/**
 * Deposit and withdrawal routes expose different status vocabularies.
 *
 * The legacy deposit DTO ends at `confirmed`, while withdrawals expose the
 * unified ledger where `confirmed` is optimistic and only `finalized` or
 * `failed` is terminal. Keep this direction-aware or recovery can silently
 * drop a confirmed withdrawal before finalization.
 */
const SETTLED_VAULT_STATUSES_BY_DIRECTION = {
  deposit: ["confirmed", "finalized", "failed"],
  withdrawal: ["finalized", "failed"],
} as const satisfies Record<EarnMovementDirection, readonly EarnMovementStatus[]>;

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
      const settledValues =
        params.settled === undefined
          ? []
          : [[...SETTLED_VAULT_STATUSES_BY_DIRECTION[params.direction]]];
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

    async hasExternalWalletPositionOwner(params) {
      const row = await db
        .prepare(
          `SELECT 1 AS present
             FROM earn_positions
            WHERE organization_id = ?
              AND project_id = ?
              AND environment = ?
              AND kind = 'vault_direct'
              AND owner_address = ?
            LIMIT 1`
        )
        .bind(params.organizationId, params.projectId, params.environment, params.ownerAddress)
        .first<{ present: number }>();
      return Boolean(row);
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
      const rows = (result.results ?? []).map(mapMovementRow);
      return { rows: rows.slice(0, params.limit), hasMore: rows.length > params.limit };
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
      return row ? mapMovementRow(row) : null;
    },

    async aggregateExternalWalletMovements(params) {
      // Postgres numeric is exact, and every summed row shares its position's
      // deposit-token denomination, so the cast loses nothing. `COALESCE` on
      // amount_settled is belt and braces: the writer stamps it on every
      // finalized row.
      const result = await db
        .prepare(
          `SELECT position_id,
                  COALESCE(SUM(
                    CASE WHEN direction = 'deposit' AND status = 'finalized'
                         THEN COALESCE(amount_settled, amount_requested)::numeric
                         ELSE 0 END
                  ), 0)::text AS finalized_deposits,
                  COUNT(*) FILTER (
                    WHERE direction = 'withdrawal' AND status = 'finalized'
                  ) AS finalized_withdrawal_count,
                  COUNT(*) FILTER (
                    WHERE status IN ('requested', 'submitted', 'confirmed')
                  ) AS unsettled_movement_count
             FROM earn_movements
            WHERE organization_id = ?
              AND project_id = ?
              AND environment = ?
              AND owner_address = ?
            GROUP BY position_id`
        )
        .bind(params.organizationId, params.projectId, params.environment, params.ownerAddress)
        .all<{
          position_id: string;
          finalized_deposits: string;
          finalized_withdrawal_count: number;
          unsettled_movement_count: number;
        }>();
      const totals = new Map<
        string,
        {
          finalizedDeposits: string;
          finalizedWithdrawalCount: number;
          unsettledMovementCount: number;
        }
      >();
      for (const row of result.results ?? []) {
        totals.set(row.position_id, {
          finalizedDeposits: row.finalized_deposits,
          finalizedWithdrawalCount: Number(row.finalized_withdrawal_count),
          unsettledMovementCount: Number(row.unsettled_movement_count),
        });
      }
      return totals;
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
      // The owner pays its own share-account rent, recorded as the NULL funder
      // (the 0066/0067 convention: the signing wallet keeps its own rent), so
      // the exit's refund defaults back to the owner.
      ...shareAccountClaimBindings({
        createsShareAccount: input.createsShareAccount,
        shareAtaRentFunder: null,
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
      ...shareAccountClaimBindings({
        createsShareAccount: input.createsShareAccount,
        shareAtaRentFunder: null,
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

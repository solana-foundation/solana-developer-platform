// DvP trades: one row per on-chain SwapDvp, settled by the DvP swap program.
//
// Every 64-bit value crosses this boundary as a string. nonce, both amounts and
// both timestamps are u64/i64 on chain, and a JS number loses precision above
// 2^53. For the nonce that is not cosmetic: it is a PDA seed, so a rounded value
// derives a different SwapDvp address than the one a counterparty was told to
// fund. Callers convert to bigint at the edge, never number.

import type { DvpTradeStatus } from "@sdp/types";
import type { Address, Signature } from "@solana/kit";
import type { RepositoryDbClient } from "./base";

export type { DvpTradeSide, DvpTradeStatus } from "@sdp/types";

export interface DvpTradeRow {
  id: string;
  organizationId: string;
  projectId: string;
  swapDvp: Address;

  // The PDA seed tuple. Required to re-derive the address for RecoverDvp.
  settlementAuthority: Address;
  userA: Address;
  userB: Address;
  mintA: Address;
  mintB: Address;
  nonce: string;

  tokenProgramA: Address;
  tokenProgramB: Address;
  /** Each leg's mint decimals, or null when unknown. Never guessed. */
  decimalsA: number | null;
  decimalsB: number | null;
  /** Each leg's token symbol from mint metadata, or null when it carries none. */
  symbolA: string | null;
  symbolB: string | null;
  /** The transaction that settled or cancelled the trade. Null while open. */
  closeSignature: Signature | null;

  amountA: string;
  amountB: string;
  expiryTimestamp: string;
  earliestSettlementTimestamp: string | null;
  userASettlementDestination: Address;
  userBSettlementDestination: Address;
  refString: string | null;

  escrowA: Address;
  escrowB: Address;

  /**
   * Org-scoped attribution naming which registered counterparty this party is,
   * or null for an external address. App-enforced `crypto_wallet`-kind, active,
   * in the creator's org/project, address equal to the party; never operational
   * — custody capability derives from the custody lookup.
   */
  counterpartyAccountIdA: string | null;
  /** Counterparty attribution for side B; see {@link counterpartyAccountIdA}. */
  counterpartyAccountIdB: string | null;

  status: DvpTradeStatus;
  observedAt: string | null;
  /** Caller-supplied Idempotency-Key, when one was sent. */
  idempotencyKey: string | null;
  /** Hash of the terms that key was first used with. */
  idempotencyFingerprint: string | null;
  createSignature: Signature | null;
  /**
   * Block height past which the create transaction can no longer land.
   *
   * The only sound basis for calling a `creating` trade dead. Elapsed time is a
   * guess about the network; this is a fact about the transaction.
   */
  createLastValidBlockHeight: string | null;

  // Last observed escrow state. Null until the reconciler has looked.
  escrowAAmount: string | null;
  escrowBAmount: string | null;
  escrowAFrozen: boolean | null;
  escrowBFrozen: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Everything needed to persist a trade before its create is broadcast.
 *
 * The row lands at `creating`. Callers do not choose the status: the point of
 * this insert is that it happens while the outcome is still unknown.
 */
export type DvpTradeInsert = Omit<
  DvpTradeRow,
  // Written by `recordClose`, never at insert: a trade is not born closed.
  | "closeSignature"
  | "status"
  | "observedAt"
  | "createdAt"
  | "updatedAt"
  | "escrowAAmount"
  | "escrowBAmount"
  | "escrowAFrozen"
  | "escrowBFrozen"
>;

export interface DvpTradeScope {
  organizationId: string;
  projectId: string;
  /**
   * Custody wallets a wallet-scoped API key may see trades for.
   *
   * `null` or absent means unrestricted — a Clerk session, or a key that is not
   * wallet-scoped. An EMPTY ARRAY means deny everything, never "no filter". That
   * reading is the repo-wide convention for wallet allowlists (see
   * `payments.repository.postgres.ts:74-80`) and getting it backwards would turn
   * a key with no usable bindings into a key that reads the whole project.
   */
  sdpWalletIds?: string[] | null;
}

/**
 * Server-side list filters for a project's trades.
 *
 * `statuses` narrows to the given lifecycle states; `q` is a case-insensitive
 * substring over id, swap_dvp, both parties, both escrows, both mints and both
 * leg symbols. `null` means no filtering on that axis — explicit, never a
 * defaulted parameter.
 */
export interface DvpTradeListFilters {
  statuses: DvpTradeStatus[] | null;
  q: string | null;
}

export interface DvpTradeObservationUpdate {
  id: string;
  /** The status the row must still hold for this write to apply. */
  expectedStatus: DvpTradeStatus;
  status: DvpTradeStatus;
  escrowAAmount: string | null;
  escrowBAmount: string | null;
  escrowAFrozen: boolean | null;
  escrowBFrozen: boolean | null;
  observedAt: string;
}

export interface DvpTradeRepositoryContext {
  db: RepositoryDbClient;
}

export interface DvpTradeRepository {
  /** Writes the row at `creating`, before the create transaction is broadcast. */
  create(row: DvpTradeInsert): Promise<DvpTradeRow>;
  /**
   * Resolves a `creating` row once the broadcast outcome is known.
   *
   * Compare-and-swap on `creating`, so a reconciler that already resolved the
   * row from the chain wins over a late caller. Returns null when the row was
   * no longer `creating` — the same answer a lost race gives.
   *
   * `create_failed` is only for a definitive rejection. An ambiguous send —
   * a timeout, a dropped connection — must leave the row at `creating` for the
   * chain to settle, because the transaction may still land.
   */
  resolveCreate(id: string, status: "created" | "create_failed"): Promise<DvpTradeRow | null>;
  /** Null when the trade does not exist or belongs to another project. */
  getById(scope: DvpTradeScope, id: string): Promise<DvpTradeRow | null>;
  /** Null when unknown. Lookup by the address a counterparty actually sees. */
  getBySwapDvp(scope: DvpTradeScope, swapDvp: Address): Promise<DvpTradeRow | null>;
  /**
   * Open trades across every project, stalest observation first.
   *
   * Deliberately UNSCOPED, unlike every read above. The reconciler is not acting
   * for a caller — it is a background sweep, and scoping it to a project would
   * mean a trade only advances while someone happens to be looking at it.
   */
  listOpenForReconciliation(limit: number): Promise<DvpTradeRow[]>;
  /**
   * Writes an observation and the status derived from it.
   *
   * Compare-and-swap on the status the derivation was computed FROM, so a sweep
   * working from a stale read cannot overwrite a newer one. Returns null when it
   * lost that race, which is the same answer a vanished row gives.
   */
  recordObservation(input: DvpTradeObservationUpdate): Promise<DvpTradeRow | null>;
  /**
   * The trade a previous request with this key created, or null.
   *
   * Deliberately not wallet-scoped: a retry is the same caller replaying the
   * same request, and the key is already scoped to their project.
   */
  getByIdempotencyKey(projectId: string, idempotencyKey: string): Promise<DvpTradeRow | null>;
  /**
   * Frees a `create_failed` row's idempotency key so the same request can be
   * made again.
   *
   * A key is a claim on one logical request, and a create that definitively
   * never landed leaves that request unmade. Without this the failed row keeps
   * the key forever and every retry replays it, so the caller is handed a dead
   * trade for as long as they keep asking — and a caller that derives its key
   * from the payload, which the dashboard does, can never create that trade at
   * all.
   *
   * Guarded on `create_failed` in the statement rather than by the caller, because
   * that is the only status proving nothing is on chain: `creating` may still
   * land, and every other status means it already did.
   *
   * @returns Whether the key was freed. False when the row moved on first, in
   *   which case the caller must treat the replay as live.
   */
  releaseIdempotencyKey(id: string): Promise<boolean>;
  /**
   * Records the outcome of a close WE performed.
   *
   * The reconciler can only ever say `closed_unknown` for a trade whose account
   * has vanished: settle, cancel and reject all close it and none of them
   * announce which happened. But when SDP is the one that broadcast the close,
   * it knows — and leaving the sweep to shrug at a settlement the product just
   * performed is a worse answer than the one already in hand.
   *
   * Compare-and-swap on an OPEN status, so a reconciler that already observed
   * the chain keeps its reading rather than being walked backwards.
   */
  recordClose(
    id: string,
    status: "settled" | "cancelled",
    signature: Signature
  ): Promise<DvpTradeRow | null>;
  /**
   * The project's trades, newest first, narrowed by the given filters.
   *
   * The filters run SERVER-SIDE because the list is capped with no cursor: a
   * client-side filter over the newest page makes a matching trade older than
   * the page unfindable, so the narrowing must happen before the LIMIT.
   *
   * @param scope - Tenant and wallet-scope the read is bounded by.
   * @param filters - Status and search narrowing; `null` on an axis means unfiltered.
   * @param limit - Page size, applied after the filters.
   */
  listByProject(
    scope: DvpTradeScope,
    filters: DvpTradeListFilters,
    limit: number
  ): Promise<DvpTradeRow[]>;
  /**
   * Open trades naming one of these addresses, created by somebody else.
   *
   * The addresses are the caller's own custody wallet public keys, resolved
   * server-side. They are never taken from a request: a party address is the
   * only input, so accepting one would make this an oracle for enumerating any
   * address's trades.
   *
   * Excludes the caller's own project, because a trade you created already
   * appears in your list and arriving in both places would read as two trades.
   * Scoped by project rather than organization so an org that is genuinely both
   * the agent and a party — one project sets terms, another holds the wallet —
   * still discovers it.
   *
   * Reaching rows another organization owns is the point, and it is allowed by
   * exactly one thing: the `sdp_dvp_party_read` policy added in 0089, which
   * admits a SELECT when a custody wallet of the calling tenant matches
   * `user_a` or `user_b`. The address filter below is not the security boundary;
   * it is the query. The boundary is in the database and holds even if this
   * predicate is wrong.
   */
  listInboundForParty(scope: DvpInboundScope, limit: number): Promise<DvpTradeRow[]>;
  /**
   * One trade by id, with NO project or organization predicate.
   *
   * For a party acting on a trade another organization created, where a scoped
   * read returns nothing by definition. The absence of a predicate here is not
   * the absence of a boundary: `dvp_trades` forces row-level security, and a
   * tenant reaches a row it does not own through exactly one policy —
   * `sdp_dvp_party_read` (0089), which requires a custody wallet of theirs to
   * match `user_a` or `user_b`. An unrelated id returns null no matter what
   * this method does, and it returns null for a system-identity caller too,
   * because that policy is tenant-only.
   *
   * Callers must still decide WHICH leg is the caller's; being able to read a
   * trade is not permission to fund an arbitrary side of it.
   */
  getByIdAsParty(tradeId: string): Promise<DvpTradeRow | null>;
}

/** Who is asking, and which addresses make a trade theirs. */
export interface DvpInboundScope {
  organizationId: string;
  /** Excluded from the results: trades this project created are already listed. */
  projectId: string;
  /** Public keys of the caller's custody wallets. Empty means no results. */
  partyAddresses: Address[];
}

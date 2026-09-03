// DvP trades: one row per on-chain SwapDvp, settled by the DvP swap program.
//
// Every 64-bit value crosses this boundary as a string. nonce, both amounts and
// both timestamps are u64/i64 on chain, and a JS number loses precision above
// 2^53. For the nonce that is not cosmetic: it is a PDA seed, so a rounded value
// derives a different SwapDvp address than the one a counterparty was told to
// fund. Callers convert to bigint at the edge, never number.

import type { RepositoryDbClient } from "./base";

/** Last observed lifecycle state. A cache of a poll, never an event. */
export type DvpTradeStatus =
  /** Signed and recorded, broadcast outcome not yet known. The initial state. */
  | "creating"
  /** The create transaction was rejected before it could land. Nothing exists. */
  | "create_failed"
  | "created"
  | "partially_funded"
  | "funded"
  | "settled"
  | "cancelled"
  | "rejected"
  | "expired"
  /** PDA is gone but which terminal path closed it is not yet known. */
  | "closed_unknown";

/** Which leg SDP holds. The other side is an arbitrary external address. */
export type DvpTradeSide = "a" | "b";

export interface DvpTradeRow {
  id: string;
  organizationId: string;
  projectId: string;
  swapDvp: string;

  // The PDA seed tuple. Required to re-derive the address for RecoverDvp.
  settlementAuthority: string;
  userA: string;
  userB: string;
  mintA: string;
  mintB: string;
  nonce: string;

  tokenProgramA: string;
  tokenProgramB: string;

  amountA: string;
  amountB: string;
  expiryTimestamp: string;
  earliestSettlementTimestamp: string | null;
  userASettlementDestination: string;
  userBSettlementDestination: string;
  refString: string | null;

  escrowA: string;
  escrowB: string;

  sdpSide: DvpTradeSide;
  sdpWalletId: string;

  status: DvpTradeStatus;
  observedAt: string | null;
  /** Signature of the transfer that funded SDP's leg, once one is claimed. */
  sdpLegFundingSignature: string | null;
  /** Caller-supplied Idempotency-Key, when one was sent. */
  idempotencyKey: string | null;
  /** Hash of the terms that key was first used with. */
  idempotencyFingerprint: string | null;
  createSignature: string | null;
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
  | "status"
  | "observedAt"
  | "createdAt"
  | "updatedAt"
  | "escrowAAmount"
  | "escrowBAmount"
  | "escrowAFrozen"
  | "escrowBFrozen"
  | "sdpLegFundingSignature"
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
  getBySwapDvp(scope: DvpTradeScope, swapDvp: string): Promise<DvpTradeRow | null>;
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
   * Claims the right to fund SDP's leg, atomically.
   *
   * Reading the escrow and then transferring is not atomic, so two overlapping
   * requests would both see the shortfall and both send, over-funding the
   * escrow. Returns false when another request already holds the claim.
   */
  claimLegFunding(id: string, signature: string): Promise<boolean>;
  /** Releases a claim whose broadcast was definitively rejected. */
  releaseLegFunding(id: string, signature: string): Promise<void>;
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
  listByProject(scope: DvpTradeScope, limit: number): Promise<DvpTradeRow[]>;
}

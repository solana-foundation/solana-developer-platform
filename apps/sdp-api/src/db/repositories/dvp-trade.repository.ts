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
  /** Caller-supplied Idempotency-Key, when one was sent. */
  idempotencyKey: string | null;
  /** Hash of the terms that key was first used with. */
  idempotencyFingerprint: string | null;
  createSignature: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Everything needed to persist a trade before its create is broadcast.
 *
 * The row lands at `creating`. Callers do not choose the status: the point of
 * this insert is that it happens while the outcome is still unknown.
 */
export type DvpTradeInsert = Omit<DvpTradeRow, "status" | "observedAt" | "createdAt" | "updatedAt">;

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
   * The trade a previous request with this key created, or null.
   *
   * Deliberately not wallet-scoped: a retry is the same caller replaying the
   * same request, and the key is already scoped to their project.
   */
  getByIdempotencyKey(projectId: string, idempotencyKey: string): Promise<DvpTradeRow | null>;
  listByProject(scope: DvpTradeScope, limit: number): Promise<DvpTradeRow[]>;
}

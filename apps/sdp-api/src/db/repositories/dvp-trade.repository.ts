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
  createSignature: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Everything needed to persist a trade the program has just accepted. */
export type DvpTradeInsert = Omit<DvpTradeRow, "status" | "observedAt" | "createdAt" | "updatedAt">;

export interface DvpTradeScope {
  organizationId: string;
  projectId: string;
}

export interface DvpTradeRepositoryContext {
  db: RepositoryDbClient;
}

export interface DvpTradeRepository {
  create(row: DvpTradeInsert): Promise<DvpTradeRow>;
  /** Null when the trade does not exist or belongs to another project. */
  getById(scope: DvpTradeScope, id: string): Promise<DvpTradeRow | null>;
  /** Null when unknown. Lookup by the address a counterparty actually sees. */
  getBySwapDvp(scope: DvpTradeScope, swapDvp: string): Promise<DvpTradeRow | null>;
  listByProject(scope: DvpTradeScope, limit: number): Promise<DvpTradeRow[]>;
}

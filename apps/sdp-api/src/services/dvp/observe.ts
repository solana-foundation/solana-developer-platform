/**
 * Turning what the chain shows into a DvP trade status.
 *
 * Split from the RPC reads on purpose: deciding what an observation MEANS is
 * where the subtle cases live, and it should be testable without a network.
 *
 * The whole file exists because the program tells us nothing. Funding is a
 * plain `TransferChecked` to the escrow ATA — the program is never invoked, and
 * it emits no events for anything else either. So every status below is
 * inferred from account state, and is only ever a description of one moment.
 */

import type { DvpTradeStatus } from "@/db/repositories";

/** One escrow, as read. `exists: false` means the account is not on chain. */
export interface DvpLegObservation {
  exists: boolean;
  /** Raw base units. NOT a UI amount — scaling extensions never touch this. */
  amount: bigint;
  /** A frozen escrow bounces incoming transfers. Blocked, not merely unpaid. */
  frozen: boolean;
}

export interface DvpTradeObservation {
  /** Whether the SwapDvp account is still on chain and passed verification. */
  tradeAccountExists: boolean;
  legA: DvpLegObservation;
  legB: DvpLegObservation;
  /** Current cluster block height, for judging create-transaction expiry. */
  blockHeight: bigint;
}

/** The trade fields the derivation needs. A subset of `DvpTradeRow`. */
export interface DvpTradeExpectation {
  status: DvpTradeStatus;
  amountA: string;
  amountB: string;
  expiryTimestamp: string;
  /**
   * Block height past which the create can no longer land. Null on rows written
   * before this was recorded, which stay ambiguous rather than being guessed at.
   */
  createLastValidBlockHeight: string | null;
}

export interface DvpTradeDerivation {
  status: DvpTradeStatus;
  /** True when an escrow holds MORE than its target. See `surplus` below. */
  overFunded: boolean;
  frozenEscrow: boolean;
}

/** Lifecycle states from which a vanished account is genuinely terminal. */
const CLOSABLE: ReadonlySet<DvpTradeStatus> = new Set([
  "created",
  "partially_funded",
  "funded",
  "expired",
]);

/**
 * Derives the status a trade should now hold.
 *
 * @param observation - What the chain showed.
 * @param trade - The stored trade, for its targets and current status.
 * @param nowMs - Wall clock, injected so the time branches are testable.
 * @returns The derived status plus the two flags that are facts, not states.
 */
export function deriveDvpTradeState(
  observation: DvpTradeObservation,
  trade: DvpTradeExpectation,
  nowMs: number
): DvpTradeDerivation {
  const targetA = BigInt(trade.amountA);
  const targetB = BigInt(trade.amountB);

  // Settle requires `balance >= amount` on BOTH legs and refuses with
  // LegNotFunded otherwise (program/src/processor/settle_dvp.rs:222-230), so
  // `>=` is the funded threshold — not equality.
  const legAFunded = observation.legA.exists && observation.legA.amount >= targetA;
  const legBFunded = observation.legB.exists && observation.legB.amount >= targetB;
  const anyDeposit =
    (observation.legA.exists && observation.legA.amount > 0n) ||
    (observation.legB.exists && observation.legB.amount > 0n);

  const overFunded =
    (observation.legA.exists && observation.legA.amount > targetA) ||
    (observation.legB.exists && observation.legB.amount > targetB);
  const frozenEscrow =
    (observation.legA.exists && observation.legA.frozen) ||
    (observation.legB.exists && observation.legB.frozen);

  const flags = { overFunded, frozenEscrow };

  if (!observation.tradeAccountExists) {
    // Nothing at the address. Two very different reasons, and the row's own
    // status is what tells them apart.
    if (trade.status === "creating") {
      // The create was signed and recorded but never seen to land. Whether it
      // still CAN land is not a question about elapsed time — it is decided by
      // the blockhash the transaction was signed against. Past that height the
      // cluster can never accept it; before it, the transaction may yet appear.
      //
      // A row with no recorded height stays `creating` forever rather than
      // being guessed at. That is deliberate: a wrong `create_failed` reports
      // no escrow exists while its address sits on chain awaiting funds.
      const expiry = trade.createLastValidBlockHeight;
      const expired = expiry !== null && observation.blockHeight > BigInt(expiry);
      return { status: expired ? "create_failed" : "creating", ...flags };
    }
    if (CLOSABLE.has(trade.status)) {
      // It existed and now does not. Settle, Cancel and Reject all close the
      // account and none of them announce it, so the closing transaction is the
      // only thing that could tell them apart — and this sweep does not fetch
      // it. Saying `closed_unknown` is the honest answer; claiming `settled`
      // would be a guess with money attached.
      return { status: "closed_unknown", ...flags };
    }
    // Already terminal. A reconciler must never walk a trade backwards out of
    // a state something better-informed put it in.
    return { status: trade.status, ...flags };
  }

  // The account is there, so whatever else is true, the create landed.
  if (legAFunded && legBFunded) {
    return { status: "funded", ...flags };
  }

  // Expiry is only meaningful while the trade is short: a fully funded trade
  // past its expiry still needs unwinding rather than being written off, and
  // the program itself decides that at settle time.
  if (BigInt(Math.floor(nowMs / 1000)) > BigInt(trade.expiryTimestamp)) {
    return { status: "expired", ...flags };
  }

  return { status: anyDeposit ? "partially_funded" : "created", ...flags };
}

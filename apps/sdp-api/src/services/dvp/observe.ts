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
import type { DvpCloseResolution } from "./closing-transaction";

/** One escrow, as read. `exists: false` means the account is not on chain. */
export type DvpLegObservation =
  | { exists: false; tampered: false }
  | { exists: false; tampered: true }
  | {
      exists: true;
      /** Raw base units. NOT a UI amount — scaling extensions never touch this. */
      amount: bigint;
      /** A frozen escrow bounces incoming transfers. Blocked, not merely unpaid. */
      frozen: boolean;
    };

export interface DvpTradeObservation {
  /** Whether the SwapDvp account is still on chain and passed verification. */
  tradeAccountExists: boolean;
  legA: DvpLegObservation;
  legB: DvpLegObservation;
  /** Current cluster block height, for judging create-transaction expiry. */
  blockHeight: bigint;
  /** Decoded close for a vanished trade account, or null when none was found. */
  closeResolution: DvpCloseResolution | null;
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
  /** Signature attached when sponsorship completed, or null for an orphaned claim. */
  createSignature: string | null;
  /** Claim creation time used only to age unsigned orphaned claims. */
  createdAt: string;
}

/**
 * Whether a trade's close needs no further decoding.
 *
 * True once a close signature is stored AND the status says which close it was.
 * A `closed_unknown` row with a signature is not done: the decode is what lifts
 * it to settled, cancelled or rejected.
 *
 * @param trade - The stored status and close signature.
 * @returns True when `resolveDvpClose` would add nothing.
 */
export function closeIsKnown(
  trade: Pick<DvpTradeExpectation, "status"> & { closeSignature: string | null }
): boolean {
  return trade.closeSignature !== null && trade.status !== "closed_unknown";
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

/** Grace period covering a request that is still waiting on Kora's timeout. */
export const DVP_CREATE_CLAIM_GRACE_MS = 15 * 60 * 1_000;

/**
 * Derives a status when the SwapDvp account is absent from chain.
 *
 * @param observation - Chain reading carrying the current block height.
 * @param trade - Stored claim and lifecycle state.
 * @param nowMs - Current wall-clock time.
 * @returns The status justified by the missing account.
 */
function deriveMissingTradeAccountStatus(
  observation: DvpTradeObservation,
  trade: DvpTradeExpectation,
  nowMs: number
): DvpTradeStatus {
  // A decoded close beats every inference below: the transaction that closed
  // the account says exactly which terminal path it took. It also lifts a
  // `closed_unknown` written by an earlier tick that found no history yet.
  if (
    observation.closeResolution !== null &&
    (trade.status === "creating" || trade.status === "closed_unknown" || CLOSABLE.has(trade.status))
  ) {
    return observation.closeResolution.status;
  }
  if (trade.status === "creating") {
    if (trade.createSignature === null && trade.createLastValidBlockHeight === null) {
      // Nothing was signed, so nothing can be on chain. The grace period only
      // protects a live request that is still waiting for Kora.
      const orphaned = nowMs - Date.parse(trade.createdAt) >= DVP_CREATE_CLAIM_GRACE_MS;
      return orphaned ? "create_failed" : "creating";
    }
    const expiry = trade.createLastValidBlockHeight;
    return expiry !== null && observation.blockHeight > BigInt(expiry)
      ? "create_failed"
      : "creating";
  }
  return CLOSABLE.has(trade.status) ? "closed_unknown" : trade.status;
}

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
    return { status: deriveMissingTradeAccountStatus(observation, trade, nowMs), ...flags };
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

import { createClusterRpc } from "@sdp/rpc/factory";
import { GET_MULTIPLE_ACCOUNTS_LIMIT, getMultipleAccountsLamports } from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { SOL_DECIMALS } from "@sdp/types/well-known-tokens";
import type { Address } from "@solana/kit";
import { amountBelowRentMinimum, internalError } from "@/lib/errors";
import { readRentExemptMinimum } from "./rent-exempt-minimum";

/**
 * Native SOL transfers the chain refuses for rent (HOO-2375), checked before
 * SDP signs or sends anything. A plain wallet holds either no lamports or at
 * least the rent-exempt minimum for a 0-byte account, so the runtime refuses
 * (`InsufficientFundsForRent`, in preflight) a transfer that
 *
 * - pays less than the minimum to an address with no account, or
 * - leaves the sender holding more than nothing but less than the minimum.
 *
 * SDP's sponsor pays fees and a missing token account's rent, never a SOL
 * recipient's or sender's rent, so neither can be fixed by the fee payer.
 */

/** The rent-exempt minimum for a 0-byte account (a plain SOL wallet), cached per cluster. */
function readSystemAccountRentMinimum(): Promise<bigint> {
  return readRentExemptMinimum(0);
}

/** The SOL a movement sends, as the rent check reads it. */
export interface SolMovement {
  /** The sending wallet, or null when SDP cannot see what it holds. */
  source: Address | null;
  /** Each payment, by its index in the request. */
  payments: readonly { index: number; destination: Address; lamports: bigint }[];
  /**
   * The payment indexes each transaction carries, when the payments are split
   * across transactions submitted concurrently; omitted for a single transaction.
   */
  transactions?: readonly (readonly number[])[];
}

/** What the chain would refuse in a movement, and the minimum it misses. */
export interface SolRentShortfall {
  /** Payments to an address with no account below the minimum, ascending. */
  recipientIndexes: number[];
  /**
   * What the sender would hold below the minimum (lamports), at the end or,
   * for concurrent transactions, after some order of them; null when it clears.
   */
  sourceRemainderLamports: bigint | null;
  minimumLamports: bigint;
  /** The minimum as a SOL decimal string. */
  minimumAmount: string;
}

async function readLamports(addresses: readonly Address[]): Promise<Map<Address, bigint>> {
  const unique = [...new Set(addresses)];
  const rpc = createClusterRpc();
  const pages: Address[][] = [];
  for (let start = 0; start < unique.length; start += GET_MULTIPLE_ACCOUNTS_LIMIT) {
    pages.push(unique.slice(start, start + GET_MULTIPLE_ACCOUNTS_LIMIT));
  }
  const balances = (
    await Promise.all(pages.map((page) => getMultipleAccountsLamports(rpc, page)))
  ).flat();
  return new Map(unique.map((account, position) => [account, balances[position]]));
}

/** An address readLamports was asked about; it always answers every one. */
function readBalance(lamports: ReadonlyMap<Address, bigint>, account: Address): bigint {
  const balance = lamports.get(account);
  if (balance === undefined) throw internalError(`No balance was read for ${account}`);
  return balance;
}

/**
 * The lowest the sender's balance would sit above zero and below the minimum,
 * or null. Concurrent transactions land in any order, so after any subset of
 * them the sender holds the final remainder plus the rest: a sweep (remainder
 * 0) is safe only when every transaction moves at least the minimum.
 */
function sourceRemainderBelowMinimum(
  source: Address,
  balance: bigint,
  movement: SolMovement,
  minimum: bigint
): bigint | null {
  // A payment back to the source moves nothing out of it.
  const outflow = new Map(
    movement.payments.map((payment) => [
      payment.index,
      payment.destination === source ? 0n : payment.lamports,
    ])
  );
  const total = [...outflow.values()].reduce((sum, lamports) => sum + lamports, 0n);
  // Not enough to send at all: the funding checks answer that, not rent.
  if (balance < total) return null;
  const remainder = balance - total;
  if (remainder > 0n && remainder < minimum) return remainder;
  const transactions = movement.transactions ?? [];
  if (remainder === 0n && transactions.length > 1) {
    const sent = transactions.map((indexes) =>
      indexes.reduce((sum, index) => {
        const lamports = outflow.get(index);
        if (lamports === undefined) {
          throw internalError(`SOL movement transaction names unknown payment ${index}`);
        }
        return sum + lamports;
      }, 0n)
    );
    const smallest = sent.reduce((low, lamports) => (lamports < low ? lamports : low));
    if (smallest < minimum) return smallest;
  }
  return null;
}

/**
 * Finds what the chain would refuse for rent in a native SOL movement.
 *
 * RPC: the minimum is cached, so usually none; then one batched
 * getMultipleAccounts (per 100 distinct addresses) for the source and the
 * destinations paid less than the minimum.
 *
 * @returns The shortfall, or null when the movement clears it.
 */
export async function findSolRentShortfall(
  movement: SolMovement
): Promise<SolRentShortfall | null> {
  const minimumLamports = await readSystemAccountRentMinimum();
  const small = movement.payments.filter((payment) => payment.lamports < minimumLamports);
  const reads = small.map((payment) => payment.destination);
  if (movement.source !== null) reads.push(movement.source);
  if (reads.length === 0) return null;
  const lamports = await readLamports(reads);

  const recipientIndexes = small
    .filter((payment) => readBalance(lamports, payment.destination) === 0n)
    .map((payment) => payment.index)
    .sort((a, b) => a - b);
  const sourceRemainderLamports =
    movement.source === null
      ? null
      : sourceRemainderBelowMinimum(
          movement.source,
          readBalance(lamports, movement.source),
          movement,
          minimumLamports
        );
  if (recipientIndexes.length === 0 && sourceRemainderLamports === null) return null;
  return {
    recipientIndexes,
    sourceRemainderLamports,
    minimumLamports,
    minimumAmount: formatDecimalAmount(minimumLamports, SOL_DECIMALS),
  };
}

/** The shortfall's sentences, for an error or a warning. */
export function describeSolRentShortfall(
  shortfall: SolRentShortfall,
  subject: "batch" | "transfer"
): string {
  const parts: string[] = [];
  const { recipientIndexes, minimumAmount } = shortfall;
  if (recipientIndexes.length > 0) {
    const who =
      subject === "transfer"
        ? "The destination has"
        : `${recipientIndexes.length === 1 ? "Recipient" : "Recipients"} ${recipientIndexes.join(", ")} ${recipientIndexes.length === 1 ? "sends to an address that has" : "send to addresses that have"}`;
    parts.push(
      `${who} no account, so ${subject === "transfer" ? "it must receive" : "each must receive"} at least ${minimumAmount} SOL, the rent-exempt minimum.`
    );
  }
  if (shortfall.sourceRemainderLamports !== null) {
    parts.push(
      `The source wallet would be left with ${formatDecimalAmount(shortfall.sourceRemainderLamports, SOL_DECIMALS)} SOL, below the ${minimumAmount} SOL rent-exempt minimum: send its whole balance in one transaction, or leave at least the minimum.`
    );
  }
  return parts.join(" ");
}

/**
 * Refuses a movement with a rent shortfall: 409, never stored under an
 * Idempotency-Key, so the same request runs again once it would clear.
 */
export async function assertNoSolRentShortfall(
  movement: SolMovement,
  subject: "batch" | "transfer"
): Promise<void> {
  const shortfall = await findSolRentShortfall(movement);
  if (shortfall === null) return;
  throw amountBelowRentMinimum(describeSolRentShortfall(shortfall, subject), {
    recipientIndexes: shortfall.recipientIndexes,
    sourceRemainder:
      shortfall.sourceRemainderLamports === null
        ? null
        : formatDecimalAmount(shortfall.sourceRemainderLamports, SOL_DECIMALS),
    minimumAmount: shortfall.minimumAmount,
    minimumLamports: shortfall.minimumLamports.toString(),
  });
}

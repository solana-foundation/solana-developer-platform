import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import {
  GET_MULTIPLE_ACCOUNTS_LIMIT,
  getMinimumBalanceForRentExemption,
  getMultipleAccountsLamports,
} from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { SOL_DECIMALS } from "@sdp/types/well-known-tokens";
import type { Address } from "@solana/kit";
import { amountBelowRentMinimum } from "@/lib/errors";

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

/** Rent parameters are cluster state that almost never changes; re-read hourly. */
const RENT_MINIMUM_TTL_MS = 60 * 60 * 1000;

const rentMinimumByCluster = new Map<string, { expiresAt: number; lamports: Promise<bigint> }>();

/**
 * The rent-exempt minimum for a 0-byte account (a plain SOL wallet), read
 * from the open cluster scope's chain and kept per cluster for an hour.
 * Concurrent reads share one request, and a failed read is never kept.
 */
function readSystemAccountRentMinimum(): Promise<bigint> {
  const cluster = currentClusterScope().cluster;
  const cached = rentMinimumByCluster.get(cluster);
  if (cached && cached.expiresAt > Date.now()) return cached.lamports;
  const lamports = getMinimumBalanceForRentExemption(createClusterRpc(), 0);
  const entry = { expiresAt: Date.now() + RENT_MINIMUM_TTL_MS, lamports };
  rentMinimumByCluster.set(cluster, entry);
  lamports.catch(() => {
    if (rentMinimumByCluster.get(cluster) === entry) rentMinimumByCluster.delete(cluster);
  });
  return lamports;
}

/** @internal Test-only: forget the cached rent minimum. */
export function clearRentMinimumCacheForTests(): void {
  rentMinimumByCluster.clear();
}

/** The SOL a movement sends, as the rent check reads it. */
export interface SolMovement {
  /** The sending wallet, or null when SDP cannot see what it holds. */
  source: Address | null;
  /** Each payment, by its index in the request. */
  payments: readonly { index: number; destination: Address; lamports: bigint }[];
  /**
   * Lamports per transaction, when the payments are split across transactions
   * submitted concurrently; omitted for a single transaction.
   */
  transactionLamports?: readonly bigint[];
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

/**
 * The lowest the sender's balance would sit above zero and below the minimum,
 * or null. Concurrent transactions land in any order, so after any subset of
 * them the sender holds the final remainder plus the rest: a sweep (remainder
 * 0) is safe only when every transaction moves at least the minimum.
 */
function sourceRemainderBelowMinimum(
  balance: bigint,
  movement: SolMovement,
  minimum: bigint
): bigint | null {
  const total = movement.payments.reduce((sum, payment) => sum + payment.lamports, 0n);
  // Not enough to send at all: the funding checks answer that, not rent.
  if (balance < total) return null;
  const remainder = balance - total;
  if (remainder > 0n && remainder < minimum) return remainder;
  const transactions = movement.transactionLamports ?? [];
  if (remainder === 0n && transactions.length > 1) {
    const smallest = transactions.reduce((low, lamports) => (lamports < low ? lamports : low));
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
    .filter((payment) => lamports.get(payment.destination) === 0n)
    .map((payment) => payment.index)
    .sort((a, b) => a - b);
  const sourceBalance = movement.source === null ? undefined : lamports.get(movement.source);
  const sourceRemainderLamports =
    sourceBalance === undefined
      ? null
      : sourceRemainderBelowMinimum(sourceBalance, movement, minimumLamports);
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

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
import type { ResolvedBatchRequest } from "./types";

/** Rent parameters are cluster state that almost never changes; re-read hourly. */
const RENT_MINIMUM_TTL_MS = 60 * 60 * 1000;

const rentMinimumByCluster = new Map<string, { expiresAt: number; lamports: Promise<bigint> }>();

/**
 * The rent-exempt minimum for a 0-byte account (a plain SOL wallet), read
 * from the open cluster scope's chain and kept per cluster for an hour. Concurrent reads share one
 * request, and a failed read is never kept.
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

/** Native SOL recipients the chain would refuse for rent, and the minimum they miss. */
export interface RentMinimumShortfall {
  /** Recipient indexes, ascending. */
  recipientIndexes: number[];
  minimumLamports: bigint;
  /** The minimum as a SOL decimal string. */
  minimumAmount: string;
}

/**
 * Finds native SOL recipients whose address holds no account and whose amount
 * is below the rent-exempt minimum (HOO-2375). The chain refuses such a
 * transfer in preflight, which fails every recipient in its transaction; a
 * retry fails the same way until the address is funded. Each recipient is
 * judged alone, because chunks are submitted concurrently in no set order.
 *
 * RPC: the minimum is cached, so usually none; then one batched
 * getMultipleAccounts per 100 distinct addresses, only for recipients paid
 * less than the minimum. A batch with no such recipient reads no account.
 *
 * @returns The shortfall, or null for an SPL batch or when every recipient clears it.
 */
export async function findRentMinimumShortfall(
  resolved: ResolvedBatchRequest
): Promise<RentMinimumShortfall | null> {
  if (resolved.tokenContext.kind !== "sol") return null;
  const minimumLamports = await readSystemAccountRentMinimum();
  const small = resolved.recipients.filter(
    (recipient) => recipient.amountBaseUnits < minimumLamports
  );
  if (small.length === 0) return null;

  const rpc = createClusterRpc();
  const addresses = [...new Set<Address>(small.map((recipient) => recipient.destinationAddress))];
  const pages: Address[][] = [];
  for (let start = 0; start < addresses.length; start += GET_MULTIPLE_ACCOUNTS_LIMIT) {
    pages.push(addresses.slice(start, start + GET_MULTIPLE_ACCOUNTS_LIMIT));
  }
  const balances = (
    await Promise.all(pages.map((page) => getMultipleAccountsLamports(rpc, page)))
  ).flat();
  const missing = new Set(addresses.filter((_, position) => balances[position] === 0n));

  const recipientIndexes = small
    .filter((recipient) => missing.has(recipient.destinationAddress))
    .map((recipient) => recipient.index);
  if (recipientIndexes.length === 0) return null;
  return {
    recipientIndexes,
    minimumLamports,
    minimumAmount: formatDecimalAmount(minimumLamports, SOL_DECIMALS),
  };
}

/**
 * Refuses a batch with a rent shortfall (409, unstored, so the same
 * request under the same Idempotency-Key runs again once the address is funded) before any row is written or
 * any signer is loaded, naming the recipients to fix.
 */
export async function assertNoRentMinimumShortfall(resolved: ResolvedBatchRequest): Promise<void> {
  const shortfall = await findRentMinimumShortfall(resolved);
  if (shortfall === null) return;
  throw amountBelowRentMinimum(
    `${shortfall.recipientIndexes.length === 1 ? "Recipient" : "Recipients"} ${shortfall.recipientIndexes.join(", ")} ${shortfall.recipientIndexes.length === 1 ? "sends" : "send"} less than ${shortfall.minimumAmount} SOL, the rent-exempt minimum, to an address with no account. Send at least the minimum, or fund the address first.`,
    {
      recipientIndexes: shortfall.recipientIndexes,
      minimumAmount: shortfall.minimumAmount,
      minimumLamports: shortfall.minimumLamports.toString(),
    }
  );
}

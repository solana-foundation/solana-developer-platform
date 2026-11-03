import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { getMinimumBalanceForRentExemption } from "@sdp/rpc/solana";

/** Rent parameters are cluster state that almost never changes; re-read hourly. */
const RENT_MINIMUM_TTL_MS = 60 * 60 * 1000;

const rentMinimumByClusterAndSize = new Map<
  string,
  { expiresAt: number; lamports: Promise<bigint> }
>();

/**
 * The rent-exempt minimum for an account of `dataSize` bytes, read from the open cluster scope's
 * chain and kept per cluster and size for an hour. Concurrent reads of one size share one request,
 * and a failed read is never kept.
 *
 * @param dataSize - Account data length in bytes.
 * @returns The minimum balance in lamports.
 */
export function readRentExemptMinimum(dataSize: number): Promise<bigint> {
  const key = `${currentClusterScope().cluster}:${dataSize}`;
  const cached = rentMinimumByClusterAndSize.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.lamports;
  const lamports = getMinimumBalanceForRentExemption(createClusterRpc(), dataSize);
  const entry = { expiresAt: Date.now() + RENT_MINIMUM_TTL_MS, lamports };
  rentMinimumByClusterAndSize.set(key, entry);
  lamports.catch(() => {
    if (rentMinimumByClusterAndSize.get(key) === entry) rentMinimumByClusterAndSize.delete(key);
  });
  return lamports;
}

/**
 * Live SOL and SPL balances for custody wallets, read from the chain.
 *
 * Home and DvP create ask for every wallet at once, often from several requests
 * together, so the read is shaped for that: SOL for every wallet the cache missed
 * comes from one `getMultipleAccounts` per 100 addresses, each wallet's token
 * programs are read side by side, and a read already running for a wallet is
 * joined rather than repeated.
 *
 * A wallet whose read failed is left out of the answer and not cached. Reporting
 * it as zero would be a guess, and caching that guess would keep showing it after
 * the RPC recovered.
 */

import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type { CustodyWalletTokenBalance } from "@sdp/types";
import { type Address, isAddress } from "@solana/kit";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";

const WALLET_BALANCE_CACHE_TTL_MS = 10_000;

export interface WalletBalanceTarget {
  id: string;
  walletId: string;
  publicKey: string;
}

/** A wallet's balances, or null when any part of the read failed. */
type WalletBalanceRead = Promise<CustodyWalletTokenBalance[] | null>;

const walletBalanceCache = new Map<
  string,
  { expiresAt: number; value: CustodyWalletTokenBalance[] }
>();

/** Reads running now, per cache key. Removed as each settles, so a failure is never replayed. */
const walletBalanceReads = new Map<string, WalletBalanceRead>();

/**
 * Bumped by every clear. A read started before a wallet changed may still finish
 * after it; it answers its own callers but must not refill the cache.
 */
let cacheGeneration = 0;

export function clearWalletBalanceCache(): void {
  walletBalanceCache.clear();
  walletBalanceReads.clear();
  cacheGeneration += 1;
}

function readCachedBalances(cacheKey: string): CustodyWalletTokenBalance[] | null {
  const entry = walletBalanceCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    walletBalanceCache.delete(cacheKey);
    return null;
  }
  return entry.value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readWalletBalance(
  rpc: solanaRpc.SolanaRpc,
  wallet: WalletBalanceTarget,
  walletAddress: Address,
  cacheKey: string,
  lamportsRead: Promise<bigint>,
  requestId: string | undefined
): WalletBalanceRead {
  const generation = cacheGeneration;
  const [solBalanceResult, splBalancesResult] = await Promise.allSettled([
    lamportsRead,
    tokenAccounts.getSplTokenBalances(rpc, walletAddress),
  ]);

  if (solBalanceResult.status === "rejected") {
    getLogger().error(
      {
        requestId,
        walletId: wallet.walletId,
        publicKey: wallet.publicKey,
        error: errorMessage(solBalanceResult.reason),
      },
      "getBalancesByWalletId: failed to fetch SOL balance"
    );
  }
  if (splBalancesResult.status === "rejected") {
    getLogger().error(
      {
        requestId,
        walletId: wallet.walletId,
        publicKey: wallet.publicKey,
        error: errorMessage(splBalancesResult.reason),
      },
      "getBalancesByWalletId: failed to fetch SPL balances"
    );
  }
  if (solBalanceResult.status === "rejected" || splBalancesResult.status === "rejected") {
    return null;
  }

  const lamports = solBalanceResult.value;
  const balances: CustodyWalletTokenBalance[] = [
    {
      token: "SOL",
      mint: tokenAccounts.SOL_MINT,
      amount: lamports.toString(),
      uiAmount: formatDecimalAmount(lamports, 9),
      decimals: 9,
    },
    ...splBalancesResult.value,
  ];
  if (generation === cacheGeneration) {
    walletBalanceCache.set(cacheKey, {
      value: balances,
      expiresAt: Date.now() + WALLET_BALANCE_CACHE_TTL_MS,
    });
  }
  return balances;
}

/**
 * Balances per wallet id for the wallets whose read succeeded. Labels are not applied:
 * a read is shared by every caller for the same cache scope and address.
 *
 * @param rpc - The cluster to read.
 * @param cacheScope - Who is asking (organization and project), prefixed to each key.
 * @param wallets - The wallets to read.
 * @param requestId - For the failure logs.
 */
export async function readWalletBalances(
  rpc: solanaRpc.SolanaRpc,
  cacheScope: string,
  wallets: readonly WalletBalanceTarget[],
  requestId: string | undefined
): Promise<Map<string, CustodyWalletTokenBalance[]>> {
  const readsByKey = new Map<string, WalletBalanceRead>();
  const unread = new Map<string, { wallet: WalletBalanceTarget; walletAddress: Address }>();

  for (const wallet of wallets) {
    const cacheKey = `${cacheScope}:${wallet.publicKey}`;
    if (readsByKey.has(cacheKey) || unread.has(cacheKey)) {
      continue;
    }
    const cached = readCachedBalances(cacheKey);
    const running = walletBalanceReads.get(cacheKey);
    if (cached) {
      readsByKey.set(cacheKey, Promise.resolve(cached));
    } else if (running) {
      readsByKey.set(cacheKey, running);
    } else if (isAddress(wallet.publicKey)) {
      unread.set(cacheKey, { wallet, walletAddress: wallet.publicKey });
    } else {
      // Nothing to read; left out like any failed read, never shown as zero.
      getLogger().error(
        { requestId, walletId: wallet.walletId, publicKey: wallet.publicKey },
        "getBalancesByWalletId: wallet public key is not a Solana address"
      );
      readsByKey.set(cacheKey, Promise.resolve(null));
    }
  }

  // One SOL read per chunk of addresses; a failed chunk fails only its own wallets.
  const unreadEntries = [...unread.entries()];
  for (
    let start = 0;
    start < unreadEntries.length;
    start += solanaRpc.GET_MULTIPLE_ACCOUNTS_LIMIT
  ) {
    const chunk = unreadEntries.slice(start, start + solanaRpc.GET_MULTIPLE_ACCOUNTS_LIMIT);
    const chunkRead = solanaRpc.getMultipleAccountsLamports(
      rpc,
      chunk.map(([, { walletAddress }]) => walletAddress)
    );
    chunk.forEach(([cacheKey, { wallet, walletAddress }], offset) => {
      const read: WalletBalanceRead = readWalletBalance(
        rpc,
        wallet,
        walletAddress,
        cacheKey,
        chunkRead.then((lamports) => lamports[offset]),
        requestId
      ).finally(() => {
        if (walletBalanceReads.get(cacheKey) === read) {
          walletBalanceReads.delete(cacheKey);
        }
      });
      walletBalanceReads.set(cacheKey, read);
      readsByKey.set(cacheKey, read);
    });
  }

  const balancesByKey = new Map<string, CustodyWalletTokenBalance[] | null>();
  await Promise.all(
    [...readsByKey.entries()].map(async ([cacheKey, read]) => {
      balancesByKey.set(cacheKey, await read);
    })
  );

  const balancesByWalletId = new Map<string, CustodyWalletTokenBalance[]>();
  for (const wallet of wallets) {
    const balances = balancesByKey.get(`${cacheScope}:${wallet.publicKey}`);
    if (balances) {
      balancesByWalletId.set(wallet.id, balances);
    }
  }
  return balancesByWalletId;
}

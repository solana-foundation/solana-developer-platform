/**
 * Live SOL and SPL balances for custody wallets, read from the chain.
 *
 * Home and DvP create ask for every wallet at once, often from several requests
 * together, so the read is shaped for that: SOL for every cache-missed wallet
 * comes from its own address-bound `getBalance` call — a batched answer could
 * only be matched back to wallets by position, and a permuted same-length batch
 * would attribute one wallet's SOL to another and cache it under its key — and
 * each wallet's token programs are read side by side. A read already running
 * for a wallet is joined rather than repeated, and each leg — the SOL balance
 * read and the token-program reads — runs under its own concurrency bound, so
 * a slow token scan never holds back another wallet's SOL read and a cold
 * cache never turns a large wallet set into an unbounded burst of requests
 * against the RPC provider.
 *
 * A wallet whose read failed is left out of the answer and not cached. Reporting
 * it as zero would be a guess, and caching that guess would keep showing it after
 * the RPC recovered.
 */

import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type { CustodyWalletTokenBalance } from "@sdp/types";
import { type Address, isAddress } from "@solana/kit";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";

const WALLET_BALANCE_CACHE_TTL_MS = 10_000;

/**
 * The most reads of each leg (the SOL balance read, the token-program reads)
 * in flight at once, when WALLET_BALANCE_READ_CONCURRENCY is unset: a cold
 * cache for a whole project must not burst the RPC provider with a request
 * per wallet, while a bound low enough to serialize a large project's reads
 * behind its slowest leg would make those requests take minutes.
 */
const DEFAULT_WALLET_BALANCE_READ_CONCURRENCY = 16;

/**
 * Resolves the per-leg read fan-out bound from the environment.
 *
 * Cold-read latency scales with the wave count per leg, not the request
 * count — a cold cache for N wallets needs ceil(N / bound) waves of each
 * leg — so a deployment whose provider has headroom can raise this to cut
 * those reads down, while the burst-rejection risk a higher bound carries
 * stays a deliberate deployment choice rather than a code default.
 *
 * @param raw - The raw env value, or undefined when unset.
 * @returns The bound: at most this many reads of a leg are in flight at once.
 */
export function parseWalletBalanceReadConcurrency(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_WALLET_BALANCE_READ_CONCURRENCY;
  }
  // `Number()` rejects trailing garbage by returning NaN ("8abc" -> NaN),
  // unlike `Number.parseInt` which would silently truncate to 8.
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid WALLET_BALANCE_READ_CONCURRENCY: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export const WALLET_BALANCE_READ_CONCURRENCY = parseWalletBalanceReadConcurrency(
  process.env.WALLET_BALANCE_READ_CONCURRENCY
);

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

/** A wallet's SPL token balances, as the token-accounts flow shapes them. */
type SplBalancesRead = ReturnType<typeof tokenAccounts.getSplTokenBalances>;

async function readWalletBalance(
  wallet: WalletBalanceTarget,
  cacheKey: string,
  lamportsRead: Promise<bigint>,
  splBalancesRead: SplBalancesRead,
  requestId: string | undefined
): WalletBalanceRead {
  const generation = cacheGeneration;
  const [solBalanceResult, splBalancesResult] = await Promise.allSettled([
    lamportsRead,
    splBalancesRead,
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

  // One address-bound SOL read per wallet; a failed read fails only its own
  // wallet. Each call names one address, so its answer is bound to that wallet
  // alone and a malicious or broken RPC cannot shuffle balances across wallets.
  // Every unread wallet's read is registered before any of them starts, so a
  // caller asking while reads are still queued joins them instead of starting
  // a duplicate; the gates hold each leg's RPC traffic back until the bounded
  // mappings below open a slot for it.
  const openSolGates = new Map<string, () => void>();
  const openTokenGates = new Map<string, () => void>();
  const solReads = new Map<string, Promise<bigint>>();
  const tokenReads = new Map<string, SplBalancesRead>();
  for (const [cacheKey, { wallet, walletAddress }] of unread) {
    let openSolGate!: () => void;
    const solGate = new Promise<void>((open) => {
      openSolGate = open;
    });
    openSolGates.set(cacheKey, openSolGate);
    let openTokenGate!: () => void;
    const tokenGate = new Promise<void>((open) => {
      openTokenGate = open;
    });
    openTokenGates.set(cacheKey, openTokenGate);

    const solRead = solGate.then(() => solanaRpc.getBalanceLamports(rpc, walletAddress));
    solReads.set(cacheKey, solRead);
    const tokenRead = tokenGate.then(() => tokenAccounts.getSplTokenBalances(rpc, walletAddress));
    tokenReads.set(cacheKey, tokenRead);

    const read: WalletBalanceRead = readWalletBalance(
      wallet,
      cacheKey,
      solRead,
      tokenRead,
      requestId
    ).finally(() => {
      if (walletBalanceReads.get(cacheKey) === read) {
        walletBalanceReads.delete(cacheKey);
      }
    });
    walletBalanceReads.set(cacheKey, read);
    readsByKey.set(cacheKey, read);
  }

  // Each leg drains through its own pool of WALLET_BALANCE_READ_CONCURRENCY
  // reads in flight: one address-bound getBalance per wallet on the SOL leg,
  // two token-program scans per wallet on the token leg. The legs hold
  // independent slots — a wallet's slow token scan does not keep another
  // wallet's SOL read queued behind it — and neither pool scales with the
  // wallet count. The mappings are settled: a rejected read still fails only
  // its own wallet.
  await Promise.all([
    mapSettledWithConcurrency(
      [...solReads],
      WALLET_BALANCE_READ_CONCURRENCY,
      async ([cacheKey, solRead]) => {
        openSolGates.get(cacheKey)?.();
        await solRead;
      }
    ),
    mapSettledWithConcurrency(
      [...tokenReads],
      WALLET_BALANCE_READ_CONCURRENCY,
      async ([cacheKey, tokenRead]) => {
        openTokenGates.get(cacheKey)?.();
        await tokenRead;
      }
    ),
  ]);

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

// biome-ignore lint/style/noRestrictedImports: the one module that sends Helius DAS requests
import { fetchHeliusDas, isHeliusDasConfigured } from "@sdp/rpc/helius-das";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { logVendorCallFailure } from "@/runtime/vendor-calls";
import { fetchJupiterUsdPrices } from "@/services/jupiter-price.service";
import { createMintLookupCache } from "@/services/mint-lookup-cache";
import type { Env } from "@/types/env";

/** A symbol changes rarely, if ever; an hour keeps a renamed token from lingering long. */
const TOKEN_SYMBOL_CACHE_TTL_MS = 60 * 60_000;

const tokenSymbolCache = createMintLookupCache<string>(TOKEN_SYMBOL_CACHE_TTL_MS);

/** @internal Test-only: forget cached symbols so specs are order-independent. */
export function clearHeliusDasCachesForTests(): void {
  tokenSymbolCache.clearForTests();
}

interface HeliusRpcError {
  code?: number;
  message?: string;
}

/** The `token_info` fields symbol lookups read; amounts come from the chain, never from DAS. */
interface HeliusTokenInfo {
  symbol?: string | null;
}

interface HeliusGetAssetBatchItem {
  id?: string;
  content?: {
    metadata?: {
      symbol?: string | null;
    };
  };
  token_info?: HeliusTokenInfo | null;
}

interface HeliusGetAssetBatchResponse {
  error?: HeliusRpcError;
  result?: HeliusGetAssetBatchItem[];
}

async function dasRequest(init: RequestInit): Promise<unknown> {
  const startedAt = Date.now();
  const fail = (error: unknown) => {
    logVendorCallFailure("helius-das", "rpc", error, startedAt);
    throw error;
  };
  let response: Response;
  try {
    response = await fetchHeliusDas(init);
  } catch (error) {
    return fail(error);
  }
  if (!response.ok) {
    return fail(new Error(`Helius DAS request failed (${response.status})`));
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return fail(error);
  }
  const rpcError = (payload as { error?: { message?: string } } | null)?.error?.message;
  if (rpcError) {
    return fail(new Error(rpcError));
  }
  return payload;
}

async function fetchFungibleAssetsByMint(
  mints: string[],
  requestId: string
): Promise<HeliusGetAssetBatchItem[]> {
  if (mints.length === 0) {
    return [];
  }

  const payload = (await dasRequest({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "getAssetBatch",
      params: {
        ids: mints,
        displayOptions: {
          showFungible: true,
        },
      },
    }),
  })) as HeliusGetAssetBatchResponse;

  return payload.result ?? [];
}

function resolveAssetSymbol(asset: HeliusGetAssetBatchItem): string | null {
  const symbol = asset.token_info?.symbol?.trim() || asset.content?.metadata?.symbol?.trim() || "";
  return symbol.length > 0 ? symbol : null;
}

async function fetchTokenSymbolsByMint(mints: string[]): Promise<Map<string, string>> {
  const assets = await fetchFungibleAssetsByMint(mints, `wallet-symbols-${mints.length}`);
  const symbolsByMint = new Map<string, string>();

  for (const asset of assets) {
    const mint = asset.id?.trim();
    const symbol = resolveAssetSymbol(asset);
    if (mint && symbol) {
      symbolsByMint.set(mint, symbol);
    }
  }

  return symbolsByMint;
}

function needsTokenSymbol(balance: Pick<CustodyWalletTokenBalance, "token" | "mint">): boolean {
  const token = balance.token.trim();
  const mint = balance.mint.trim();
  return token.length === 0 || token === mint;
}

function enrichBalancesWithTokenSymbols(
  balances: CustodyWalletTokenBalance[],
  symbolsByMint: Map<string, string>
): CustodyWalletTokenBalance[] {
  return balances.map((balance) => {
    if (!needsTokenSymbol(balance)) {
      return balance;
    }

    const symbol = symbolsByMint.get(balance.mint.trim());
    return symbol ? { ...balance, token: symbol } : balance;
  });
}

// Symbols decorate balances: with no Helius endpoint on the scope's cluster they stay unset,
// and a balance read never fails on them.
export async function attachTokenSymbolsToBalances(
  balances: CustodyWalletTokenBalance[]
): Promise<CustodyWalletTokenBalance[]> {
  const unresolvedMints = [
    ...new Set(
      balances.filter((balance) => needsTokenSymbol(balance)).map((balance) => balance.mint)
    ),
  ];

  if (!isHeliusDasConfigured() || unresolvedMints.length === 0) {
    return balances;
  }

  // A failed lookup answers no mints, so those balances keep their mint as the label.
  const symbolsByMint = await tokenSymbolCache.lookup(
    currentClusterScope().cluster,
    unresolvedMints,
    (mints) => fetchTokenSymbolsByMint(mints)
  );
  return enrichBalancesWithTokenSymbols(balances, symbolsByMint);
}

export async function attachTokenSymbolsToBalanceMap(
  balancesByWalletId: Map<string, CustodyWalletTokenBalance[]>
): Promise<Map<string, CustodyWalletTokenBalance[]>> {
  const allBalances = [...balancesByWalletId.values()].flat();
  const enrichedBalances = await attachTokenSymbolsToBalances(allBalances);
  let cursor = 0;

  return new Map(
    [...balancesByWalletId.entries()].map(([walletId, balances]) => {
      const nextCursor = cursor + balances.length;
      const walletBalances = enrichedBalances.slice(cursor, nextCursor);
      cursor = nextCursor;
      return [walletId, walletBalances] as const;
    })
  );
}

/** What pricing reads from a balance: its mint and the amount a wallet shows. */
type PricedBalanceInput = Pick<CustodyWalletTokenBalance, "mint" | "displayAmount">;

/** A balance with the USD price and value Jupiter gave it, when it gave one. */
type WithUsdValue<T> = T & { usdPrice?: number; usdValue?: number };

/**
 * Sets `usdPrice` and `usdValue` on each balance Jupiter priced. A mint it did not price
 * stays unpriced: a symbol, a stablecoin template or a peg is not a market price, and
 * anyone can mint a token called "USDC". The value prices the display amount, which is
 * what a price per token refers to on a scaled or interest-bearing mint.
 *
 * @param balances - Balances to decorate.
 * @param pricesByMint - Jupiter USD prices keyed by mint.
 * @returns The balances, priced where a price exists.
 */
function enrichBalancesWithUsdValues<T extends PricedBalanceInput>(
  balances: readonly T[],
  pricesByMint: Map<string, number>
): WithUsdValue<T>[] {
  return balances.map((balance) => {
    const usdPrice = pricesByMint.get(balance.mint);
    if (usdPrice === undefined) {
      return balance;
    }
    return {
      ...balance,
      usdPrice,
      usdValue: Number((Number(balance.displayAmount) * usdPrice).toFixed(6)),
    };
  });
}

/** Jupiter USD prices for the distinct mints across `balances`. */
function fetchUsdPricesForBalances(
  env: Env,
  balances: readonly PricedBalanceInput[]
): Promise<Map<string, number>> {
  return fetchJupiterUsdPrices(env, [...new Set(balances.map((balance) => balance.mint))]);
}

export async function attachUsdValuesToBalances<T extends PricedBalanceInput>(
  env: Env,
  balances: readonly T[]
): Promise<WithUsdValue<T>[]> {
  const pricesByMint = await fetchUsdPricesForBalances(env, balances);
  return enrichBalancesWithUsdValues(balances, pricesByMint);
}

export async function attachUsdValuesToBalanceMap(
  env: Env,
  balancesByWalletId: Map<string, CustodyWalletTokenBalance[]>
): Promise<Map<string, CustodyWalletTokenBalance[]>> {
  const pricesByMint = await fetchUsdPricesForBalances(
    env,
    [...balancesByWalletId.values()].flat()
  );

  return new Map(
    [...balancesByWalletId.entries()].map(([walletId, balances]) => [
      walletId,
      enrichBalancesWithUsdValues(balances, pricesByMint),
    ])
  );
}

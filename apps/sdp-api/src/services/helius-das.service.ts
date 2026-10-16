// biome-ignore lint/style/noRestrictedImports: the one module that sends Helius DAS requests
import { fetchHeliusDas, isHeliusDasConfigured } from "@sdp/rpc/helius-das";
import { currentClusterScope } from "@sdp/rpc/scope";
import { formatDecimalAmount } from "@sdp/solana/amount";
import {
  type CustodyWalletTokenBalance,
  WELL_KNOWN_TOKEN_BY_MINT,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import { logVendorCallFailure } from "@/runtime/vendor-calls";
import { fetchJupiterUsdPrices } from "@/services/jupiter-price.service";
import { createMintLookupCache } from "@/services/mint-lookup-cache";
import type { Env } from "@/types/env";

/** A symbol changes rarely, if ever; an hour keeps a renamed token from lingering long. */
const TOKEN_SYMBOL_CACHE_TTL_MS = 60 * 60_000;
/** Matches the Jupiter price TTL: a price older than this is not shown as current. */
const USD_PRICE_CACHE_TTL_MS = 30_000;

const tokenSymbolCache = createMintLookupCache<string>(TOKEN_SYMBOL_CACHE_TTL_MS);
const usdPriceCache = createMintLookupCache<number>(USD_PRICE_CACHE_TTL_MS);

/** @internal Test-only: forget cached symbols and prices so specs are order-independent. */
export function clearHeliusDasCachesForTests(): void {
  tokenSymbolCache.clearForTests();
  usdPriceCache.clearForTests();
}

interface TrackedAssetDefinition {
  decimals: number;
  isUsdStable?: boolean;
  mint: string;
  token: string;
}

interface HeliusRpcError {
  code?: number;
  message?: string;
}

interface HeliusTokenInfo {
  amount?: number | string | null;
  balance?: number | string | null;
  decimals?: number | null;
  mint?: string | null;
  symbol?: string | null;
  uiAmount?: number | string | null;
  ui_amount?: number | string | null;
  uiAmountString?: string | null;
  ui_amount_string?: string | null;
  price_info?: {
    price_per_token?: number | null;
    currency?: string | null;
  } | null;
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

async function resolveTrackedAssets(env: Env): Promise<Map<string, TrackedAssetDefinition>> {
  const network = currentClusterScope().cluster;
  const usdc = WELL_KNOWN_TOKENS.USDC;
  const usdcMint = usdc.mints[network];
  const trackedAssets: TrackedAssetDefinition[] = [
    {
      token: usdc.symbol,
      mint: usdcMint.address,
      decimals: usdcMint.decimals,
      isUsdStable: usdc.isUsdStable,
    },
  ];

  const trackedAssetsByMint = new Map(trackedAssets.map((asset) => [asset.mint, asset]));

  try {
    const result = await getDb(env)
      .prepare(
        `SELECT t.mint_address, t.symbol, t.decimals
           FROM issued_tokens t
           JOIN projects p ON p.id = t.project_id
          WHERE p.environment = ?
            AND t.template = 'stablecoin'
            AND t.mint_address IS NOT NULL
            AND t.deployed_at IS NOT NULL`
      )
      .bind(currentClusterScope().environment)
      .all<{
        decimals?: number | null;
        mint_address?: string | null;
        symbol?: string | null;
      }>();

    for (const row of result.results ?? []) {
      const mint = row.mint_address?.trim();
      if (!mint) {
        continue;
      }

      trackedAssetsByMint.set(mint, {
        token: row.symbol?.trim() || mint,
        mint,
        decimals:
          typeof row.decimals === "number" && Number.isInteger(row.decimals) && row.decimals >= 0
            ? row.decimals
            : 6,
        isUsdStable: true,
      });
    }
  } catch (error) {
    getLogger().warn(
      { error: error instanceof Error ? error.message : String(error) },
      "resolveTrackedAssets: issued stablecoin lookup failed; pricing built-in assets only"
    );
  }

  return trackedAssetsByMint;
}

function resolveKnownUsdPrice(
  balance: Pick<CustodyWalletTokenBalance, "mint" | "token">,
  trackedAssets: Map<string, TrackedAssetDefinition>
): number | null {
  const normalizedMint = balance.mint.trim();
  const trackedAsset = trackedAssets.get(normalizedMint);
  if (trackedAsset?.isUsdStable) {
    return 1;
  }

  const normalizedToken = balance.token.trim().toUpperCase();
  const wellKnown =
    WELL_KNOWN_TOKEN_BY_MINT.get(normalizedMint) ??
    Object.values(WELL_KNOWN_TOKENS).find((token) => token.symbol === normalizedToken);
  if (wellKnown?.isUsdStable) {
    return 1;
  }

  return null;
}

function parseIntegerString(value: number | string | null | undefined): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return /^\d+$/.test(normalized) ? normalized : null;
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  ) {
    return value.toString();
  }

  return null;
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

async function fetchUsdPricesByMint(mints: string[]): Promise<Map<string, number>> {
  const assets = await fetchFungibleAssetsByMint(mints, `wallet-prices-${mints.length}`);
  const pricesByMint = new Map<string, number>();

  for (const asset of assets) {
    const mint = asset.id?.trim();
    const pricePerToken = asset.token_info?.price_info?.price_per_token;
    const currency = asset.token_info?.price_info?.currency?.trim().toUpperCase() ?? "USD";

    if (
      mint &&
      typeof pricePerToken === "number" &&
      Number.isFinite(pricePerToken) &&
      pricePerToken >= 0 &&
      (currency === "USD" || currency === "USDC")
    ) {
      pricesByMint.set(mint, pricePerToken);
    }
  }

  return pricesByMint;
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

// Symbols and USD values decorate balances: with no Helius endpoint on the scope's cluster they
// stay unset, and a balance read never fails on them.
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

async function resolveUsdPricesForBalances(
  env: Env,
  balances: CustodyWalletTokenBalance[]
): Promise<{
  pricesByMint: Map<string, number>;
  trackedAssets: Map<string, TrackedAssetDefinition>;
}> {
  const trackedAssets = await resolveTrackedAssets(env);
  const pricesByMint = new Map<string, number>();

  for (const balance of balances) {
    const knownUsdPrice = resolveKnownUsdPrice(balance, trackedAssets);
    if (knownUsdPrice !== null) {
      pricesByMint.set(balance.mint, knownUsdPrice);
    }
  }

  const unresolvedMints = [...new Set(balances.map((balance) => balance.mint))].filter(
    (mint) => !pricesByMint.has(mint)
  );

  if (unresolvedMints.length === 0) {
    return { pricesByMint, trackedAssets };
  }

  // Jupiter first: it prices from the last swapped price across all venues, so it covers
  // the long tail Helius DAS has no entry for — which is everything that is neither
  // USD-stable nor in Helius's index, and is why a token like USDY rendered unpriced.
  const jupiterPrices = await fetchJupiterUsdPrices(env, unresolvedMints);
  for (const [mint, price] of jupiterPrices) {
    pricesByMint.set(mint, price);
  }

  // Helius stays as a fallback rather than being deleted. Jupiter omits any mint it
  // cannot price reliably, including anything untraded recently, and Helius still
  // answers for some of those. Narrowing coverage is not the point of the change.
  const stillUnresolved = unresolvedMints.filter((mint) => !pricesByMint.has(mint));
  if (!isHeliusDasConfigured() || stillUnresolved.length === 0) {
    return { pricesByMint, trackedAssets };
  }

  // A failed lookup answers no mints; those balances stay unpriced.
  const fetchedPrices = await usdPriceCache.lookup(
    currentClusterScope().cluster,
    stillUnresolved,
    (mints) => fetchUsdPricesByMint(mints)
  );
  for (const [mint, price] of fetchedPrices) {
    pricesByMint.set(mint, price);
  }

  return { pricesByMint, trackedAssets };
}

function enrichBalancesWithUsdValues(
  balances: CustodyWalletTokenBalance[],
  pricesByMint: Map<string, number>,
  trackedAssets: Map<string, TrackedAssetDefinition>
): CustodyWalletTokenBalance[] {
  return balances.map((balance) => {
    const usdPrice = pricesByMint.get(balance.mint) ?? resolveKnownUsdPrice(balance, trackedAssets);
    const uiAmount = Number(balance.uiAmount);

    if (usdPrice === null || !Number.isFinite(usdPrice) || !Number.isFinite(uiAmount)) {
      return balance;
    }

    return {
      ...balance,
      usdPrice,
      usdValue: Number((uiAmount * usdPrice).toFixed(6)),
    };
  });
}

export async function attachUsdValuesToBalances(
  env: Env,
  balances: CustodyWalletTokenBalance[]
): Promise<CustodyWalletTokenBalance[]> {
  const { pricesByMint, trackedAssets } = await resolveUsdPricesForBalances(env, balances);
  return enrichBalancesWithUsdValues(balances, pricesByMint, trackedAssets);
}

export async function attachUsdValuesToBalanceMap(
  env: Env,
  balancesByWalletId: Map<string, CustodyWalletTokenBalance[]>
): Promise<Map<string, CustodyWalletTokenBalance[]>> {
  const allBalances = [...balancesByWalletId.values()].flat();
  const { pricesByMint, trackedAssets } = await resolveUsdPricesForBalances(env, allBalances);

  return new Map(
    [...balancesByWalletId.entries()].map(([walletId, balances]) => [
      walletId,
      enrichBalancesWithUsdValues(balances, pricesByMint, trackedAssets),
    ])
  );
}

export function aggregateTrackedWalletBalances(
  balanceSets: CustodyWalletTokenBalance[][]
): CustodyWalletTokenBalance[] {
  const aggregate = new Map<
    string,
    { token: string; mint: string; amount: bigint; decimals: number }
  >();

  for (const balances of balanceSets) {
    for (const balance of balances) {
      const current = aggregate.get(balance.mint);
      const rawAmount = parseIntegerString(balance.amount) ?? "0";
      if (!current) {
        aggregate.set(balance.mint, {
          token: balance.token,
          mint: balance.mint,
          amount: BigInt(rawAmount),
          decimals: balance.decimals,
        });
        continue;
      }

      current.amount += BigInt(rawAmount);
    }
  }

  return [...aggregate.values()]
    .map((entry) => ({
      token: entry.token,
      mint: entry.mint,
      amount: entry.amount.toString(),
      uiAmount: formatDecimalAmount(entry.amount, entry.decimals),
      decimals: entry.decimals,
    }))
    .sort((left, right) => right.token.localeCompare(left.token));
}

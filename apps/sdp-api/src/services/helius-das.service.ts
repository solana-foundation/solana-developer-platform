import {
  createClusterDasRpc,
  type DasAsset,
  type DasRpc,
  type DasTokenInfo,
} from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { formatDecimalAmount } from "@sdp/solana/amount";
import {
  type CustodyWalletTokenBalance,
  WELL_KNOWN_TOKEN_BY_MINT,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
import { getDb } from "@/db";
import { withVendorCall } from "@/runtime/vendor-calls";
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
        `SELECT mint_address, symbol, decimals
         FROM issued_tokens
        WHERE template = 'stablecoin'
          AND mint_address IS NOT NULL
          AND deployed_at IS NOT NULL`
      )
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
  } catch {
    // Ignore database lookup failures and fall back to built-in tracked assets.
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

function parseDecimalString(value: number | string | null | undefined): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return /^\d+(\.\d+)?$/.test(normalized) ? normalized : null;
  }

  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value.toString();
  }

  return null;
}

function decimalToRawAmount(value: string, decimals: number): string {
  const [wholePart, fractionalPart = ""] = value.split(".");
  const normalizedWhole = wholePart.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fractionalPart.slice(0, decimals).padEnd(decimals, "0");
  const combined = `${normalizedWhole}${normalizedFraction}`.replace(/^0+(?=\d)/, "");
  return combined || "0";
}

function resolveUiAmount(tokenInfo: DasTokenInfo, rawAmount: string, decimals: number): string {
  const directUiAmount =
    parseDecimalString(tokenInfo.uiAmountString) ??
    parseDecimalString(tokenInfo.ui_amount_string) ??
    parseDecimalString(tokenInfo.uiAmount) ??
    parseDecimalString(tokenInfo.ui_amount);

  if (directUiAmount) {
    return directUiAmount;
  }

  return formatDecimalAmount(BigInt(rawAmount), decimals);
}

function toTrackedTokenBalance(
  item: DasAsset,
  trackedAssets: Map<string, TrackedAssetDefinition>
): CustodyWalletTokenBalance | null {
  const tokenInfo = item.token_info;
  if (!tokenInfo) {
    return null;
  }

  const mint = tokenInfo.mint?.trim() || item.id?.trim() || "";
  const symbol = tokenInfo.symbol?.trim() || item.content?.metadata?.symbol?.trim() || "";
  const trackedAsset =
    (mint ? trackedAssets.get(mint) : null) ??
    [...trackedAssets.values()].find((asset) => asset.token === symbol.toUpperCase());

  if (!trackedAsset) {
    return null;
  }

  const decimals =
    typeof tokenInfo.decimals === "number" && Number.isFinite(tokenInfo.decimals)
      ? tokenInfo.decimals
      : trackedAsset.decimals;
  const rawAmountCandidate =
    parseIntegerString(tokenInfo.balance) ?? parseIntegerString(tokenInfo.amount);
  const uiAmountCandidate =
    parseDecimalString(tokenInfo.uiAmountString) ??
    parseDecimalString(tokenInfo.ui_amount_string) ??
    parseDecimalString(tokenInfo.uiAmount) ??
    parseDecimalString(tokenInfo.ui_amount);
  const rawAmount =
    rawAmountCandidate ??
    (uiAmountCandidate ? decimalToRawAmount(uiAmountCandidate, decimals) : "0");

  return {
    token: trackedAsset.token,
    mint: mint || trackedAsset.mint,
    amount: rawAmount,
    uiAmount: resolveUiAmount(tokenInfo, rawAmount, decimals),
    decimals,
  };
}

async function fetchTrackedBalancesForOwner(
  dasRpc: DasRpc,
  ownerAddress: string,
  trackedAssets: Map<string, TrackedAssetDefinition>
): Promise<CustodyWalletTokenBalance[]> {
  const result = await withVendorCall("helius-das", "rpc", () =>
    dasRpc
      .searchAssets({
        ownerAddress,
        tokenType: "fungible",
        page: 1,
        limit: 1000,
        displayOptions: {
          showFungible: true,
        },
      })
      .send()
  );

  return (result.items ?? [])
    .map((item) => toTrackedTokenBalance(item, trackedAssets))
    .filter((balance): balance is CustodyWalletTokenBalance => Boolean(balance));
}

async function fetchFungibleAssetsByMint(
  dasRpc: DasRpc,
  mints: string[]
): Promise<readonly DasAsset[]> {
  if (mints.length === 0) {
    return [];
  }

  return await withVendorCall("helius-das", "rpc", () =>
    dasRpc
      .getAssetBatch({
        ids: mints,
        displayOptions: {
          showFungible: true,
        },
      })
      .send()
  );
}

async function fetchUsdPricesByMint(dasRpc: DasRpc, mints: string[]): Promise<Map<string, number>> {
  const assets = await fetchFungibleAssetsByMint(dasRpc, mints);
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

function resolveAssetSymbol(asset: DasAsset): string | null {
  const symbol = asset.token_info?.symbol?.trim() || asset.content?.metadata?.symbol?.trim() || "";
  return symbol.length > 0 ? symbol : null;
}

async function fetchTokenSymbolsByMint(
  dasRpc: DasRpc,
  mints: string[]
): Promise<Map<string, string>> {
  const assets = await fetchFungibleAssetsByMint(dasRpc, mints);
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

export async function attachTokenSymbolsToBalances(
  balances: CustodyWalletTokenBalance[]
): Promise<CustodyWalletTokenBalance[]> {
  const dasRpc = createClusterDasRpc();
  const unresolvedMints = [
    ...new Set(
      balances.filter((balance) => needsTokenSymbol(balance)).map((balance) => balance.mint)
    ),
  ];

  if (!dasRpc || unresolvedMints.length === 0) {
    return balances;
  }

  // A failed lookup answers no mints, so those balances keep their mint as the label.
  const symbolsByMint = await tokenSymbolCache.lookup(
    currentClusterScope().cluster,
    unresolvedMints,
    (mints) => fetchTokenSymbolsByMint(dasRpc, mints)
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
  const dasRpc = createClusterDasRpc();
  if (!dasRpc || stillUnresolved.length === 0) {
    return { pricesByMint, trackedAssets };
  }

  // A failed lookup answers no mints; those balances stay unpriced.
  const fetchedPrices = await usdPriceCache.lookup(
    currentClusterScope().cluster,
    stillUnresolved,
    (mints) => fetchUsdPricesByMint(dasRpc, mints)
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

export async function getTrackedWalletBalancesByOwner(
  env: Env,
  ownerAddresses: string[]
): Promise<Map<string, CustodyWalletTokenBalance[]>> {
  const dasRpc = createClusterDasRpc();
  const balancesByOwner = new Map<string, CustodyWalletTokenBalance[]>();

  for (const ownerAddress of ownerAddresses) {
    balancesByOwner.set(ownerAddress, []);
  }

  if (!dasRpc || ownerAddresses.length === 0) {
    return balancesByOwner;
  }

  const trackedAssets = await resolveTrackedAssets(env);
  const uniqueOwners = [...new Set(ownerAddresses)];
  const results = await Promise.allSettled(
    uniqueOwners.map(async (ownerAddress) => ({
      ownerAddress,
      balances: await fetchTrackedBalancesForOwner(dasRpc, ownerAddress, trackedAssets),
    }))
  );

  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }

    balancesByOwner.set(result.value.ownerAddress, result.value.balances);
  }

  return balancesByOwner;
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

import {
  type CustodyWalletTokenBalance,
  WELL_KNOWN_TOKEN_BY_MINT,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
import { getDb } from "@/db";
import { formatDecimalAmount } from "@/lib/amount";
import { withHeliusApiKey } from "@/services/rpc-relay.service";
import type { Env } from "@/types/env";

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

interface HeliusSearchAssetItem {
  id?: string;
  content?: {
    metadata?: {
      symbol?: string | null;
    };
  };
  token_info?: HeliusTokenInfo | null;
}

interface HeliusSearchAssetsResponse {
  error?: HeliusRpcError;
  result?: {
    items?: HeliusSearchAssetItem[];
  };
}

interface HeliusGetAssetBatchItem {
  id?: string;
  token_info?: HeliusTokenInfo | null;
}

interface HeliusGetAssetBatchResponse {
  error?: HeliusRpcError;
  result?: HeliusGetAssetBatchItem[];
}

async function resolveTrackedAssets(env: Env): Promise<Map<string, TrackedAssetDefinition>> {
  const network = env.SOLANA_NETWORK ?? "devnet";
  const usdc = WELL_KNOWN_TOKENS.USDC;
  const trackedAssets: TrackedAssetDefinition[] = [
    {
      token: usdc.symbol,
      mint: usdc.mints[network],
      decimals: usdc.decimals,
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

function resolveHeliusDasUrl(env: Env): string | null {
  if (!env.SOLANA_RPC_HELIUS_URL) {
    return null;
  }

  return withHeliusApiKey(env.SOLANA_RPC_HELIUS_URL, env.SOLANA_RPC_HELIUS_API_KEY);
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

function resolveUiAmount(tokenInfo: HeliusTokenInfo, rawAmount: string, decimals: number): string {
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
  item: HeliusSearchAssetItem,
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
  heliusDasUrl: string,
  ownerAddress: string,
  trackedAssets: Map<string, TrackedAssetDefinition>
): Promise<CustodyWalletTokenBalance[]> {
  const response = await fetch(heliusDasUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `wallet-balances-${ownerAddress.slice(-8)}`,
      method: "searchAssets",
      params: {
        ownerAddress,
        tokenType: "fungible",
        page: 1,
        limit: 1000,
        displayOptions: {
          showFungible: true,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Helius DAS request failed (${response.status})`);
  }

  const payload = (await response.json()) as HeliusSearchAssetsResponse;
  if (payload.error?.message) {
    throw new Error(payload.error.message);
  }

  return (payload.result?.items ?? [])
    .map((item) => toTrackedTokenBalance(item, trackedAssets))
    .filter((balance): balance is CustodyWalletTokenBalance => Boolean(balance));
}

async function fetchUsdPricesByMint(
  heliusDasUrl: string,
  mints: string[]
): Promise<Map<string, number>> {
  if (mints.length === 0) {
    return new Map();
  }

  const response = await fetch(heliusDasUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `wallet-prices-${mints.length}`,
      method: "getAssetBatch",
      params: {
        ids: mints,
        displayOptions: {
          showFungible: true,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Helius DAS request failed (${response.status})`);
  }

  const payload = (await response.json()) as HeliusGetAssetBatchResponse;
  if (payload.error?.message) {
    throw new Error(payload.error.message);
  }

  const pricesByMint = new Map<string, number>();

  for (const asset of payload.result ?? []) {
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

  const heliusDasUrl = resolveHeliusDasUrl(env);
  const unresolvedMints = [...new Set(balances.map((balance) => balance.mint))].filter(
    (mint) => !pricesByMint.has(mint)
  );

  if (!heliusDasUrl || unresolvedMints.length === 0) {
    return { pricesByMint, trackedAssets };
  }

  try {
    const fetchedPrices = await fetchUsdPricesByMint(heliusDasUrl, unresolvedMints);
    for (const [mint, price] of fetchedPrices) {
      pricesByMint.set(mint, price);
    }
  } catch {
    // Ignore price lookup failures; callers will fall back to unpriced balances.
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
  const heliusDasUrl = resolveHeliusDasUrl(env);
  const balancesByOwner = new Map<string, CustodyWalletTokenBalance[]>();

  for (const ownerAddress of ownerAddresses) {
    balancesByOwner.set(ownerAddress, []);
  }

  if (!heliusDasUrl || ownerAddresses.length === 0) {
    return balancesByOwner;
  }

  const trackedAssets = await resolveTrackedAssets(env);
  const uniqueOwners = [...new Set(ownerAddresses)];
  const results = await Promise.allSettled(
    uniqueOwners.map(async (ownerAddress) => ({
      ownerAddress,
      balances: await fetchTrackedBalancesForOwner(heliusDasUrl, ownerAddress, trackedAssets),
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

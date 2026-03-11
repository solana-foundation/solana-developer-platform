import { formatDecimalAmount } from "@/lib/amount";
import { withHeliusApiKey } from "@/services/rpc-relay.service";
import type { Env } from "@/types/env";
import type { CustodyWalletTokenBalance } from "@sdp/types";

// biome-ignore lint/nursery/noSecrets: Devnet USDC mint address constant, not a secret.
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// biome-ignore lint/nursery/noSecrets: Mainnet USDC mint address constant, not a secret.
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface TrackedAssetDefinition {
  decimals: number;
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

function resolveTrackedAssets(env: Env): Map<string, TrackedAssetDefinition> {
  const network = env.SOLANA_NETWORK ?? "devnet";
  const trackedAssets: TrackedAssetDefinition[] =
    network === "mainnet-beta"
      ? [{ token: "USDC", mint: MAINNET_USDC_MINT, decimals: 6 }]
      : [{ token: "USDC", mint: DEVNET_USDC_MINT, decimals: 6 }];

  return new Map(trackedAssets.map((asset) => [asset.mint, asset]));
}

function resolveHeliusDasUrl(env: Env): string | null {
  if (!env.SOLANA_RPC_HELIUS_URL) {
    return null;
  }

  return withHeliusApiKey(env.SOLANA_RPC_HELIUS_URL, env.SOLANA_RPC_HELIUS_API_KEY);
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

  const trackedAssets = resolveTrackedAssets(env);
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

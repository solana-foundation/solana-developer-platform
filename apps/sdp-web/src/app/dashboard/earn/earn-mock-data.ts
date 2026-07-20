import type { EarnStrategy } from "@sdp/types";

/**
 * Mock catalogue for the Earn design scaffold. This file is the ONLY data
 * seam in the flow: swap these fixtures for the /api/dashboard/earn BFF
 * fetchers (already stubbed) once the first vault-infra provider sync lands,
 * and the workspace + wizard keep working unchanged.
 */

export const EARN_RISK_TIERS = ["conservative", "balanced", "enhanced"] as const;
export type EarnRiskTier = (typeof EARN_RISK_TIERS)[number];

export type MockEarnStrategy = EarnStrategy & {
  /** Display-only extras until NAV snapshots feed the catalogue. */
  tvlUsd: number;
  riskTier: EarnRiskTier;
  curator: string;
};

const MOCK_TIMESTAMP = "2026-07-18T09:00:00.000Z";

function strategy(
  partial: Omit<MockEarnStrategy, "status" | "createdAt" | "updatedAt" | "riskMetadata">
): MockEarnStrategy {
  return {
    ...partial,
    riskMetadata: { curator: partial.curator, riskTier: partial.riskTier },
    status: "active",
    createdAt: MOCK_TIMESTAMP,
    updatedAt: MOCK_TIMESTAMP,
  };
}

// Mainnet mints for USDC / USDG / USDT (matches WELL_KNOWN_TOKENS in @sdp/types).
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDG = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export const MOCK_TOKEN_SYMBOLS: Readonly<Record<string, string>> = {
  [USDC]: "USDC",
  [USDG]: "USDG",
  [USDT]: "USDT",
};

export const MOCK_EARN_STRATEGIES: readonly MockEarnStrategy[] = [
  strategy({
    id: "earn_strategy_mock_buidl",
    provider: "veda",
    providerReference: "veda-buidl-sweep",
    name: "BUIDL Treasury Sweep",
    sourceKind: "rwa",
    underlyingSource: "buidl",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: "0.046",
    liquidityTerm: "instant",
    riskTier: "conservative",
    curator: "steakhouse",
    tvlUsd: 512_400_000,
  }),
  strategy({
    id: "earn_strategy_mock_benji",
    provider: "upshift",
    providerReference: "upshift-benji-mmf",
    name: "BENJI Money Market",
    sourceKind: "rwa",
    underlyingSource: "benji",
    depositMints: [USDC, USDG],
    apyType: "variable",
    currentApy: "0.044",
    liquidityTerm: "instant",
    riskTier: "conservative",
    curator: "gauntlet",
    tvlUsd: 287_900_000,
  }),
  strategy({
    id: "earn_strategy_mock_kamino",
    provider: "veda",
    providerReference: "veda-kamino-usdc",
    name: "Kamino USDC Lend",
    sourceKind: "defi",
    underlyingSource: "kamino",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: "0.062",
    liquidityTerm: "instant",
    riskTier: "balanced",
    curator: "gauntlet",
    tvlUsd: 164_300_000,
  }),
  strategy({
    id: "earn_strategy_mock_juplend",
    provider: "perena",
    providerReference: "perena-jup-lend-stable",
    name: "Jup Lend Stable",
    sourceKind: "defi",
    underlyingSource: "jup-lend",
    depositMints: [USDC, USDT],
    apyType: "variable",
    currentApy: "0.058",
    liquidityTerm: "instant",
    riskTier: "balanced",
    curator: "sentora",
    tvlUsd: 98_700_000,
  }),
  strategy({
    id: "earn_strategy_mock_ousg",
    provider: "upshift",
    providerReference: "upshift-ousg-treasuries",
    name: "OUSG Short Treasuries",
    sourceKind: "rwa",
    underlyingSource: "ousg",
    depositMints: [USDC, USDG],
    apyType: "fixed",
    currentApy: "0.051",
    liquidityTerm: "delayed",
    redemptionDelayDays: 2,
    riskTier: "balanced",
    curator: "steakhouse",
    tvlUsd: 143_100_000,
  }),
  strategy({
    id: "earn_strategy_mock_syrup",
    provider: "ground",
    providerReference: "ground-syrup-usdc",
    name: "Syrup USDC Credit",
    sourceKind: "rwa",
    underlyingSource: "syrup-usdc",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: "0.084",
    liquidityTerm: "delayed",
    redemptionDelayDays: 7,
    riskTier: "enhanced",
    curator: "gauntlet",
    tvlUsd: 61_500_000,
  }),
];

export interface MockEarnWallet {
  id: string;
  name: string;
  /** Display-unit balances keyed by mint. */
  balances: Readonly<Record<string, number>>;
}

export const MOCK_EARN_WALLETS: readonly MockEarnWallet[] = [
  {
    id: "wallet_mock_treasury",
    name: "Operating treasury",
    balances: { [USDC]: 1_250_000, [USDG]: 400_000, [USDT]: 180_000 },
  },
  {
    id: "wallet_mock_reserve",
    name: "Yield reserve",
    balances: { [USDC]: 3_800_000, [USDG]: 950_000, [USDT]: 0 },
  },
];

export function getMockStrategy(strategyId: string): MockEarnStrategy | undefined {
  return MOCK_EARN_STRATEGIES.find((candidate) => candidate.id === strategyId);
}

export function tokenSymbol(mint: string): string {
  return MOCK_TOKEN_SYMBOLS[mint] ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function formatApy(apy: string | undefined): string {
  if (!apy) return "—";
  const value = Number(apy);
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function formatUsd(value: number): string {
  return usdFormatter.format(value);
}

const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatUsdCompact(value: number): string {
  return compactUsdFormatter.format(value);
}

const amountFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatTokenAmount(value: number, mint: string): string {
  return `${amountFormatter.format(value)} ${tokenSymbol(mint)}`;
}

/** Simple simple-interest projection for the preview panel (display only). */
export function projectYearlyYield(amount: number, apy: string | undefined): number {
  const rate = Number(apy ?? 0);
  if (!Number.isFinite(rate) || !Number.isFinite(amount)) return 0;
  return amount * rate;
}

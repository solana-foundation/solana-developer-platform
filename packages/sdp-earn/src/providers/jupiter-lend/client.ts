import { JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import { providerUnavailable } from "../../errors";
import { providerFetchJson } from "../../fetch";
import type {
  EarnDeclaredStrategySupport,
  EarnLiveMetricsProvider,
  EarnRuntimeContext,
  ProviderStrategyMetrics,
  ProviderStrategySnapshot,
} from "../../types";
import { StubEarnClient } from "../stub";

export const JUPITER_LEND_API_URL = "https://lite-api.jup.ag/lend/v1";
export const JUPITER_LEND_USDT_MINT = JUPITER_LEND_USDT.assetMint;
const REQUEST_TIMEOUT_MS = 10_000;

interface JupiterEarnToken {
  address?: unknown;
  assetAddress?: unknown;
  decimals?: unknown;
  totalAssets?: unknown;
  totalRate?: unknown;
}

function integerString(value: unknown): string | undefined {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : undefined;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  return value.replace(/^0+(?=\d)/, "");
}

/** Convert provider basis points to a decimal fraction without floating point. */
export function jupiterRateFromBps(value: unknown): string | undefined {
  const digits = integerString(value);
  if (digits === undefined) return undefined;
  return (
    `${digits.padStart(5, "0").slice(0, -4)}.${digits.padStart(5, "0").slice(-4)}`
      .replace(/^0+(?=\d)/, "")
      .replace(/\.?0+$/, "") || "0"
  );
}

function atomicUsdtToUsd(value: unknown): number | undefined {
  const digits = integerString(value);
  if (digits === undefined) return undefined;
  const result = Number(digits) / 1_000_000;
  return Number.isFinite(result) ? result : undefined;
}

function isUsdtToken(token: JupiterEarnToken): boolean {
  return token.assetAddress === JUPITER_LEND_USDT_MINT;
}

function assertUsdtIdentity(
  token: JupiterEarnToken
): asserts token is JupiterEarnToken & { address: string; decimals: 6 } {
  if (token.address !== JUPITER_LEND_USDT.shareMint || token.decimals !== 6) {
    throw providerUnavailable("Jupiter Lend returned an invalid USDT lending-token identity");
  }
}

export class JupiterLendEarnClient extends StubEarnClient implements EarnLiveMetricsProvider {
  readonly provider = "jupiter_lend" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["defi"],
    depositTokens: ["USDT"],
  };

  private async listTokens(): Promise<JupiterEarnToken[]> {
    const response = await providerFetchJson<unknown>(
      this.provider,
      `${JUPITER_LEND_API_URL}/earn/tokens`,
      { method: "GET", timeoutMs: REQUEST_TIMEOUT_MS }
    );
    if (!Array.isArray(response)) {
      throw providerUnavailable("Jupiter Lend returned a token catalogue that was not an array");
    }
    return response as JupiterEarnToken[];
  }

  override async listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    if (ctx.environment !== "production") return [];
    const token = (await this.listTokens()).find(isUsdtToken);
    if (!token) return [];
    assertUsdtIdentity(token);
    const tvlUsd = atomicUsdtToUsd(token.totalAssets);
    return [
      {
        providerReference: JUPITER_LEND_USDT_MINT,
        name: "Jupiter Lend USDT",
        sourceKind: "defi",
        underlyingSource: "Jupiter Lend",
        depositMints: [JUPITER_LEND_USDT_MINT],
        shareMint: token.address,
        hostCluster: "mainnet-beta",
        apyType: "variable",
        currentApy: jupiterRateFromBps(token.totalRate),
        liquidityTerm: "instant",
        riskMetadata: {
          curator: "jupiter",
          ...(tvlUsd === undefined ? {} : { tvlUsd }),
        },
      },
    ];
  }

  async listStrategyMetrics(ctx: EarnRuntimeContext): Promise<ProviderStrategyMetrics[]> {
    if (ctx.environment !== "production") return [];
    const token = (await this.listTokens()).find(isUsdtToken);
    if (!token) return [];
    assertUsdtIdentity(token);
    const tvlUsd = atomicUsdtToUsd(token.totalAssets);
    return [
      {
        providerReference: JUPITER_LEND_USDT_MINT,
        currentApy: jupiterRateFromBps(token.totalRate),
        riskMetadata: tvlUsd === undefined ? {} : { tvlUsd },
      },
    ];
  }
}

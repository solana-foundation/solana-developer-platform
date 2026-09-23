import {
  HASTRA_DEPOSIT_TOKEN_SYMBOLS,
  hastraDeployment,
  hastraDepositMints,
} from "@sdp/types/hastra-programs";
import { providerNotConfigured } from "../../errors";
import type {
  EarnDeclaredStrategySupport,
  EarnLiveMetricsProvider,
  EarnRuntimeContext,
  ProviderStrategyMetrics,
  ProviderStrategySnapshot,
} from "../../types";
import { StubEarnClient } from "../stub";
import { readHastraPrimeMetrics } from "./prime-metrics";

/**
 * Catalogue half of Hastra PRIME.
 *
 * PRIME is a non-rebasing share token for Figure's Democratized Prime HELOC
 * pool. The executable route is USDC -> wYLDS through Hastra `vault-mint`,
 * then wYLDS -> PRIME through `vault-stake`; `@sdp/hastra` owns those
 * instructions while this SDK-free client owns the one admitted strategy.
 *
 * The identity is deliberately a single pinned deployment, not a program
 * account census. Hastra's programs can create more vaults, but an arbitrary
 * vault is not evidence that Figure issued its underlying assets. The program
 * and mint addresses come from the verified v0.0.6 registry in
 * `@sdp/types/hastra-programs`.
 *
 * Hastra's public proof-of-reserves feed supplies PRIME's effective APY and its
 * Solana vault balance. Both the hourly catalogue pass and five-minute metrics
 * pass read that feed: the former cannot erase figures written by the latter.
 * The APY is issuer-published, never derived from share-price samples.
 */
export class HastraEarnClient extends StubEarnClient implements EarnLiveMetricsProvider {
  readonly provider = "hastra" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["rwa"],
    depositTokens: HASTRA_DEPOSIT_TOKEN_SYMBOLS,
  };

  override async listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    // SDP has not verified or admitted a complete Hastra devnet token/config
    // deployment. Sandbox receives this production row through the API's
    // browse-only mainnet mirror and cannot fund it.
    if (ctx.environment !== "production") return [];

    const deployment = hastraDeployment("mainnet-beta");
    if (!deployment) {
      throw providerNotConfigured("Hastra PRIME has no verified mainnet-beta deployment");
    }

    const depositMints = hastraDepositMints("mainnet-beta");
    if (depositMints.length === 0) {
      throw providerNotConfigured("Hastra PRIME has no admitted USDC mint on mainnet-beta");
    }
    const metrics = await readHastraPrimeMetrics(deployment.primeMint);

    return [
      {
        // PRIME is both the strategy identity and the wallet-held share token.
        providerReference: deployment.primeMint,
        name: "Hastra PRIME",
        sourceKind: "rwa",
        underlyingSource: "figure-democratized-prime-heloc",
        depositMints: [...depositMints],
        shareMint: deployment.primeMint,
        hostCluster: "mainnet-beta",
        apyType: "variable",
        currentApy: metrics.currentApy,
        // The conservative catalogue posture follows the default at-par route,
        // which is operator-mediated and carries no on-chain completion SLA.
        // Deployments may separately opt into the atomic Jupiter market exit.
        liquidityTerm: "delayed",
        riskMetadata: {
          curator: "hastra",
          issuer: "Hastra",
          yieldSource: "Figure Democratized Prime HELOC pool",
          wrapperAsset: "wYLDS",
          priceOracle: "Chainlink Data Streams",
          programRelease: deployment.release,
          tvlUsd: metrics.solanaTvlUsd,
          parExit: "PRIME to wYLDS atomically, then Hastra operator-mediated redemption",
          optionalDexExit:
            "PRIME to wYLDS to USDC through Jupiter when enabled by the integrating deployment",
        },
      },
    ];
  }

  async listStrategyMetrics(ctx: EarnRuntimeContext): Promise<ProviderStrategyMetrics[]> {
    if (ctx.environment !== "production") return [];

    const deployment = hastraDeployment("mainnet-beta");
    if (!deployment) {
      throw providerNotConfigured("Hastra PRIME has no verified mainnet-beta deployment");
    }
    const metrics = await readHastraPrimeMetrics(deployment.primeMint);
    return [
      {
        providerReference: metrics.providerReference,
        currentApy: metrics.currentApy,
        riskMetadata: { tvlUsd: metrics.solanaTvlUsd },
      },
    ];
  }
}

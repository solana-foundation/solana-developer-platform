import { PLUME_CHAIN_ID, PLUME_VAULTS } from "@sdp/types/plume-programs";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { internalError } from "#/errors";
import { StubEarnClient } from "#/providers/stub";
import type {
  EarnDeclaredStrategySupport,
  EarnRuntimeContext,
  ProviderStrategySnapshot,
} from "#/types";
import { plumeRequest, plumeVaultInfoSchema } from "./api";

export class PlumeEarnClient extends StubEarnClient {
  readonly provider = "plume" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["rwa"],
    depositTokens: ["USDC"],
  };

  override async listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    if (ctx.environment !== "production") return [];
    const usdc = wellKnownMint("USDC", "mainnet-beta");
    if (usdc === undefined) throw internalError("Plume requires the canonical mainnet USDC mint");
    return Promise.all(
      PLUME_VAULTS.map(async (vault): Promise<ProviderStrategySnapshot> => {
        const info = await plumeRequest(
          `/vaults/${encodeURIComponent(vault.slug)}`,
          plumeVaultInfoSchema
        );
        // Strict V2 selection: a legacy entry's absent metadata never equals
        // the chain id, and an enabled deposit is required, so the one allowed
        // composer is a fully-formed V2 entry for Plume's chain.
        const composers = info.nestComposers.filter(
          (c) =>
            c.complianceVersion === "v2" &&
            c.chainId === PLUME_CHAIN_ID &&
            c.cctpDepositEnabled === true
        );
        if (
          info.slug !== vault.slug ||
          info.solana.mintAddress !== vault.shareMint ||
          info.solana.oftStoreAddress !== vault.oftStore ||
          info.solana.decimals !== vault.shareDecimals ||
          info.decimals !== vault.plumeShareDecimals ||
          composers.length !== 1 ||
          composers[0]?.composerAddress.toLowerCase() !== vault.mintComposer.toLowerCase()
        ) {
          throw internalError("Plume vault identity differs from its approved deployment");
        }
        const snapshot: ProviderStrategySnapshot = {
          providerReference: vault.shareMint,
          name: vault.name,
          sourceKind: "rwa",
          underlyingSource: vault.slug,
          depositMints: [usdc],
          shareMint: vault.shareMint,
          hostCluster: vault.cluster,
          apyType: "variable",
          liquidityTerm: "delayed",
          riskMetadata: { curator: "plume" },
        };
        // Reported target yield is not a measured current yield. Keep it out of currentApy.
        // A null figure is absence — omit it instead of stringifying it, and
        // store the number itself: catalogue ranking and Treasury read
        // `tvlUsd` as a JSON number and reject strings.
        if (info.tvl != null) snapshot.riskMetadata = { curator: "plume", tvlUsd: info.tvl };
        return snapshot;
      })
    );
  }
}

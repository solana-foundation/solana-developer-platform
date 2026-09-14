import { CLUSTER_BY_SDP_ENVIRONMENT, type SolanaCluster } from "@sdp/types";
import {
  ONDO_DEPOSIT_TOKEN_SYMBOLS,
  type OndoDeployment,
  ondoDeployment,
  ondoDepositMints,
} from "@sdp/types/ondo-programs";
import { internalError, providerNotConfigured } from "../../errors";
import { assertRpcServesCluster, fromBase64, solanaRpcCall } from "../../solana-rpc";
import type {
  EarnDeclaredStrategySupport,
  EarnRuntimeContext,
  ProviderStrategySnapshot,
} from "../../types";
import { StubEarnClient } from "../stub";

/**
 * Ondo vault-infra client — the catalogue half. `@sdp/ondo` extends this class
 * with the vault-direct capability; this package stays SDK-free so the hourly
 * catalogue cron never loads a chain SDK.
 *
 * ── What the "vault" is ─────────────────────────────────────────────────────
 * There is no vault program. USDY on Solana is a plain SPL token whose
 * per-token price accrues Treasury yield (Ondo's accumulating token), so the
 * strategy is HOLDING USDY: the deposit is a custody-signed USDC→USDY swap on
 * the secondary market, the position is the wallet's USDY balance, and the
 * exit is the reverse swap. The primary mint/redeem facility is deliberately
 * not used — fresh primary mints carry a 40–50 day Reg S transfer lockup and
 * sub-$100k redemptions wait out that window (PRO-1803, measured against
 * Ondo's docs 2026-09-02) — so nothing here needs an Ondo credential.
 *
 * ── Why `sourceKind: "rwa"` is defensible here ──────────────────────────────
 * The bar (see `packages/sdp-earn/CLAUDE.md`, the K-vault name trust boundary)
 * is that `rwa` must trace to something the PROVIDER establishes — an address
 * allowlist or verified authority, never a name or an inference. This shelf is
 * exactly that: one instrument, whose mint address Ondo publishes in its own
 * documentation, carried in `ONDO_DEPLOYMENTS` the same way `VEDA_DEPLOYMENTS`
 * carries Veda's confirmed vaults. Nothing a stranger can create reaches it.
 */

/** SPL mint account layout facts the on-chain check reads positionally. */
const SPL_MINT_ACCOUNT_SIZE = 82;
const SPL_MINT_DECIMALS_OFFSET = 44;
// biome-ignore lint/security/noSecrets: public on-chain program id, not a secret.
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** USDY's decimals, verified on-chain 2026-09-02; the check refuses drift. */
export const ONDO_USDY_DECIMALS = 6;

interface RpcAccountInfo {
  value: {
    owner?: string;
    data?: [string, string];
  } | null;
}

/**
 * Read the USDY mint and refuse anything that is not the instrument SDP
 * expects: an initialized SPL token mint with USDY's decimals, owned by the
 * classic token program. All-or-nothing like Veda's read — this address was
 * GIVEN, so a missing or misshapen account is an error, never an empty shelf
 * (an empty return is the one shape that makes the sync skip its delist pass).
 */
export async function readOndoUsdyMint(
  rpcUrl: string,
  cluster: SolanaCluster,
  deployment: OndoDeployment
): Promise<{ decimals: number }> {
  await assertRpcServesCluster("ondo", rpcUrl, cluster);

  const info = await solanaRpcCall<RpcAccountInfo>("ondo", rpcUrl, "getAccountInfo", [
    deployment.usdyMint,
    { encoding: "base64" },
  ]);
  const value = info.value;
  if (!value?.data) {
    throw internalError(`Ondo USDY mint ${deployment.usdyMint} does not exist on ${cluster}`);
  }
  if (value.owner !== SPL_TOKEN_PROGRAM_ID) {
    throw internalError(
      `Ondo USDY mint ${deployment.usdyMint} is owned by ${value.owner}, not the SPL token program`
    );
  }
  const data = fromBase64(value.data[0]);
  if (data.length !== SPL_MINT_ACCOUNT_SIZE) {
    throw internalError(
      `Ondo USDY mint account is ${data.length} bytes, not the ${SPL_MINT_ACCOUNT_SIZE} of an SPL mint`
    );
  }
  const decimals = data[SPL_MINT_DECIMALS_OFFSET];
  if (decimals !== ONDO_USDY_DECIMALS) {
    throw internalError(
      `Ondo USDY mint reports ${decimals} decimals; SDP expects ${ONDO_USDY_DECIMALS}`
    );
  }
  return { decimals };
}

export class OndoEarnClient extends StubEarnClient {
  readonly provider = "ondo" as const;

  /**
   * - **`rwa` only.** USDY is a tokenized note secured by short-term US
   *   Treasuries and bank deposits — the real-world backing is what the
   *   instrument IS, published by its issuer, and the allowlist above is what
   *   makes asserting it safe (see the class doc).
   * - **USDC only.** The pair Ondo's own market-making liquidity quotes on
   *   Solana. Other funding stablecoins ride the swap-funded deposit leg into
   *   USDC first, so widening this buys nothing.
   */
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["rwa"],
    depositTokens: ONDO_DEPOSIT_TOKEN_SYMBOLS,
  };

  /**
   * Ondo's shelf for this environment's cluster: exactly one strategy — hold
   * USDY — or `PROVIDER_NOT_CONFIGURED` where the instrument does not exist.
   *
   * Devnet has NO Ondo deployment (verified on-chain 2026-09-02, and Ondo
   * confirmed their staging environment also runs on mainnet), so the sandbox
   * catalogue carries Ondo only through the PRO-1742 browse-only mainnet
   * mirror. The cluster is MEASURED (genesis hash) before the mint is read,
   * and the mint account itself is verified, so a row here is an observation
   * about a live instrument rather than a restatement of this file.
   */
  async listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    const deployment = ondoDeployment(cluster);
    if (!deployment) {
      throw providerNotConfigured(
        `Ondo has no ${cluster} deployment: USDY exists on mainnet-beta only. ` +
          "The sandbox shelf carries it through the browse-only mainnet mirror."
      );
    }

    return this._listUsdyStrategy(ctx.env.SOLANA_RPC_URL ?? "", cluster, deployment);
  }

  /**
   * The read and the mapping with the deployment already resolved — split out
   * (Veda/Kamino pattern) so tests can exercise the mapping without the
   * registry's opinion of which clusters are deployed.
   */
  async _listUsdyStrategy(
    rpcUrl: string,
    cluster: SolanaCluster,
    deployment: OndoDeployment
  ): Promise<ProviderStrategySnapshot[]> {
    await readOndoUsdyMint(rpcUrl, cluster, deployment);

    const depositMints = ondoDepositMints(cluster);
    if (depositMints.length === 0) {
      // USDC missing from the well-known catalogue for this cluster would be a
      // registry bug, not a provider condition; fail the pass loudly.
      throw internalError(`Ondo has no admissible deposit mint on ${cluster}`);
    }

    return [
      {
        // The instrument's own mint — cluster-distinct by construction, which
        // is what lets the PRO-1742 mirror carry the row into sandbox.
        providerReference: deployment.usdyMint,
        name: "Ondo USDY",
        sourceKind: "rwa",
        underlyingSource: "ondo-usdy",
        depositMints: [...depositMints].sort(),
        // Holding USDY IS the position: the share mint is the instrument.
        shareMint: deployment.usdyMint,
        // Measured by `readOndoUsdyMint`, never derived from ctx.environment.
        hostCluster: cluster,
        // The price accrues daily at a rate Ondo sets monthly. SDP has no
        // keyless source for that figure (Ondo's API is credentialed), and one
        // reading of a market price is not a rate of return, so no
        // `currentApy` — the dashboard renders "—" rather than a fabricated
        // number. A live-metrics capability can follow once SDP holds an Ondo
        // API key (PRO-1803 follow-up).
        apyType: "variable",
        // Exit is a secondary-market swap: always open, no lock. The 40–50 day
        // Reg S lockup applies only to PRIMARY mints, which SDP does not use.
        liquidityTerm: "instant",
        riskMetadata: {
          // Ondo issues and manages the instrument; the attribution traces to
          // the issuer's own published mint address, the same bar Veda's
          // allowlist clears.
          curator: "ondo",
        },
      },
    ];
  }
}

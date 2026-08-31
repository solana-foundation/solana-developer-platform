import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type SolanaCluster,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import {
  isVedaDepositMint,
  VEDA_DEPOSIT_TOKEN_SYMBOLS,
  type VedaDeployment,
  vedaDeployment,
} from "@sdp/types/veda-programs";
import { providerNotConfigured } from "../../errors";
import type {
  EarnDeclaredStrategySupport,
  EarnRuntimeContext,
  ProviderStrategySnapshot,
} from "../../types";
import { StubEarnClient } from "../stub";
import { readVedaVaults, VEDA_UNSET_AUTHORITY, type VedaVault } from "./vault-state";

/**
 * Veda vault-infra client — the catalogue half. `@sdp/veda` extends this class
 * with the vault-direct capability (deposit building and position reads); this
 * package stays SDK-free so the hourly catalogue cron never loads a chain SDK.
 *
 * Everything here is read from the chain and nothing from a Veda API, because
 * there is no Veda API: the SDK is a client for the programs, so the catalogue
 * and the builder read the same accounts by different routes.
 */

const SECONDS_PER_DAY = 86_400;

/**
 * Deposit mints this vault actually takes, intersected with what SDP declares
 * FOR THIS CLUSTER.
 *
 * Both halves are needed and neither is redundant. The vault's own
 * `AssetData.allow_deposits` is the only truth about what it will accept;
 * `declaredSupport` is SDP's ceiling. Screening here rather than leaving it to
 * `isStrategyWithinDeclaredSupport` is the same choice the Kamino devnet path
 * makes: the sync warn-logs every out-of-envelope snapshot, and a vault
 * configured for assets SDP never claimed to front is not provider drift worth
 * a warning every hour.
 *
 * The screen is CLUSTER-AWARE — `isVedaDepositMint(mint, cluster)`, exact
 * mint membership, never a symbol comparison. A symbol-level check would admit the OTHER
 * cluster's mint of the same token: a devnet vault whose asset config names
 * mainnet USDC would produce a `hostCluster: "devnet"` row listing a mint that
 * does not exist on devnet, and the failure would surface only at deposit
 * build time as "account not found".
 */
function depositMints(entry: VedaVault, cluster: SolanaCluster): string[] {
  return entry.assets
    .filter((asset) => asset.allowDeposits)
    .map((asset) => asset.assetMint)
    .filter((mint) => isVedaDepositMint(mint, cluster))
    .sort();
}

/**
 * A display name for a vault that has none.
 *
 * `BoringVault` carries no name field, so unlike Kamino there is no
 * attacker-controlled string to quote — and nothing to parse a claim out of
 * either. The name is composed from two facts the account establishes: the
 * base asset's symbol and the vault id. A vault whose base asset is not in the
 * well-known catalogue still gets a stable, unambiguous name from its id.
 */
export function vedaVaultName(baseAsset: string, vaultId: bigint): string {
  const symbol = WELL_KNOWN_TOKEN_BY_MINT.get(baseAsset)?.symbol;
  return symbol ? `Veda ${symbol} vault #${vaultId}` : `Veda vault #${vaultId}`;
}

/**
 * How quickly a holder can get out, from what the vault configures.
 *
 * Two independent constraints, and BOTH have to be clear for `instant`:
 *
 * - `teller.withdraw_authority` — unset means redemption is permissionless,
 *   which is exactly the comparison Veda's own SDK makes to decide whether an
 *   instant withdrawal exists. A named authority means someone else has to
 *   sign, so the holder cannot leave on their own schedule.
 * - `config.lock_duration_seconds` — shares are locked for this long after a
 *   deposit, so a non-zero lock delays the exit no matter what the authority
 *   says.
 *
 * Reporting `instant` for a vault with either constraint would be the field
 * lying in the direction that costs a customer money, so both fail to `delayed`.
 */
export function vedaLiquidity(entry: VedaVault): {
  liquidityTerm: "instant" | "delayed";
  redemptionDelayDays?: number;
} {
  const lockSeconds = entry.vault.lockDurationSeconds;
  const permissionless = entry.vault.withdrawAuthority === VEDA_UNSET_AUTHORITY;
  if (permissionless && lockSeconds <= 0n) return { liquidityTerm: "instant" };
  if (lockSeconds <= 0n) return { liquidityTerm: "delayed" };
  return {
    liquidityTerm: "delayed",
    // Rounded UP: a lock that ends part-way through a day is not over until
    // that day is. Rounding down would advertise an exit a holder cannot take.
    redemptionDelayDays: Number(
      (lockSeconds + BigInt(SECONDS_PER_DAY) - 1n) / BigInt(SECONDS_PER_DAY)
    ),
  };
}

export class VedaEarnClient extends StubEarnClient {
  readonly provider = "veda" as const;

  /**
   * What SDP is willing to front, narrowed from the scaffold's guess.
   *
   * - **`defi` only.** A Veda vault is an on-chain program that mints shares
   *   against deposited assets, and that is the whole of what its own state
   *   establishes. It reaches strategies through pre-approved CPI digests, so
   *   the underlying exposure could in principle be real-world backed — but
   *   `rwa` is the one classification an integrator FILTERS on to find
   *   instruments with real-world backing, so asserting it needs something
   *   Veda publishes on-chain, not an inference from what a vault might hold.
   *   Same rule that keeps Kamino's snapshots `defi` (see
   *   `packages/sdp-earn/CLAUDE.md` → the K-vault name trust boundary).
   * - **USDC only.** The scaffold also claimed USDG and USDT, which no Veda
   *   material supports. USDT additionally has no devnet mint, so a devnet
   *   snapshot naming it could never pass `isStrategyWithinDeclaredSupport`
   *   and would warn on every hourly pass forever.
   *
   * Shared with `@sdp/veda` through `@sdp/types` rather than restated, so the
   * asset the catalogue admits and the asset the builder will spend cannot
   * drift apart.
   */
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["defi"],
    depositTokens: VEDA_DEPOSIT_TOKEN_SYMBOLS,
  };

  /**
   * Veda's shelf for this environment's cluster, read on chain.
   *
   * Two properties are worth stating plainly:
   *
   * - **The shelf is an ALLOWLIST, never a census.** Veda deploys a vault per
   *   customer under one program, so enumerating the program's accounts would
   *   put other integrators' vaults on SDP's shelf. The addresses come from
   *   `@sdp/types/veda-programs`, which only carries what Veda confirmed — and
   *   that is also what makes this provider's `sourceKind` defensible, since
   *   every row traces to an address Veda named rather than to anything a
   *   stranger could create.
   * - **The cluster is MEASURED before anything is read.** `readVedaVaults`
   *   proves the RPC's genesis hash matches, so `hostCluster` below is an
   *   observation. This matters more for Veda than for most providers: its
   *   integration material implies devnet and mainnet may share addresses, and
   *   if they do, the genesis proof is the only thing standing between reading
   *   one and reporting the other.
   *
   * No credential check: there is nothing to configure but the deployment, and
   * a missing deployment is what `PROVIDER_NOT_CONFIGURED` reports here.
   */
  async listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    const deployment = vedaDeployment(cluster);
    if (!deployment) {
      // Not a soft empty shelf: an empty return is the one shape that makes the
      // sync skip its delist pass, so it would freeze an existing catalogue
      // rather than report that SDP cannot reach Veda here.
      throw providerNotConfigured(
        `Veda has no confirmed ${cluster} deployment. Add its program and vault-state addresses to @sdp/types/veda-programs once Veda confirms them.`
      );
    }

    return this._listVaultStrategies(ctx.env.SOLANA_RPC_URL ?? "", cluster, deployment);
  }

  /**
   * The read and the mapping, with the deployment already resolved.
   *
   * Split out so tests can exercise the mapping against a deployment SDP does
   * not yet have — `VEDA_DEPLOYMENTS` is empty until Veda confirms addresses,
   * and the mapping is the half that must already be right when they do. Same
   * shape as Kamino's `_listDevnetStrategies`.
   */
  async _listVaultStrategies(
    rpcUrl: string,
    cluster: SolanaCluster,
    deployment: VedaDeployment
  ): Promise<ProviderStrategySnapshot[]> {
    const entries = await readVedaVaults(rpcUrl, cluster, deployment);

    const snapshots: ProviderStrategySnapshot[] = [];
    for (const entry of entries) {
      const mints = depositMints(entry, cluster);
      // A vault with no deposit asset SDP fronts is not an error and not a row:
      // it is a vault this deployment has nothing to offer for.
      if (mints.length === 0) continue;

      snapshots.push({
        providerReference: entry.vault.address,
        name: vedaVaultName(entry.vault.baseAsset, entry.vault.vaultId),
        // The one classification the vault's own mechanics establish. Never
        // `rwa` — see `declaredSupport` above.
        sourceKind: "defi",
        depositMints: mints,
        shareMint: entry.vault.shareMint,
        // Measured by `readVedaVaults`, never derived from `ctx.environment`.
        hostCluster: cluster,
        // The share price moves with the strategies the vault holds; nothing
        // about it is fixed. `currentApy` is deliberately absent — one reading
        // of an exchange rate is not a rate of return, and the dashboard
        // renders a missing rate as "—" rather than a fabricated number.
        apyType: "variable",
        ...vedaLiquidity(entry),
        // Protocol-reported figures only, read from the vault's own state.
        // No `curator`: nothing Veda publishes on-chain attributes one, and an
        // attribution is SDP vouching rather than quoting.
        riskMetadata: {
          platformFeeBps: entry.vault.platformFeeBps,
          performanceFeeBps: entry.vault.performanceFeeBps,
        },
      });
    }

    return snapshots;
  }
}

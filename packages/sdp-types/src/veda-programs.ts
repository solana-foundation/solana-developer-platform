import type { EarnDepositTokenSymbol } from "./earn";
import { type SolanaCluster, type WellKnownTokenSymbol, wellKnownMint } from "./well-known-tokens";

/**
 * Veda's on-chain deployment, per cluster.
 *
 * ── Why this table lives in `@sdp/types` ────────────────────────────────────
 * Two packages need it and neither may depend on the other: `@sdp/earn` reads
 * vault state directly for the hourly catalogue (`providers/veda/vault-state.ts`)
 * while `@sdp/veda` builds deposit instructions against the same programs.
 * Putting it in `@sdp/veda` would force the catalogue cron to load a chain SDK
 * it never calls — a workspace cycle `scripts/check-module-boundaries.mjs`
 * rejects outright. Same argument as `./kamino-programs`, and the same home.
 *
 * Mainnet: Veda supplied the SDP USDC PRIME and OUSD PRIME deployments in
 * November 2026. Devnet retains the separately deployed Test Vault confirmed
 * by Veda's integration guide and SDP's on-chain audit. Never infer deployment
 * addresses from the SDK's IDL defaults or enumerate other integrators' vaults.
 */
export interface VedaDeployment {
  /**
   * `boring_vault_svm` — holds vault state, mints shares, and executes deposits
   * and instant withdrawals.
   */
  vaultProgramAddress: string;
  /**
   * `boring_onchain_queue` — the request → fulfill → cancel withdrawal queue.
   *
   * Optional because the SDK reports a deployment without a queue as a
   * supported capability state rather than an error. A cluster whose queue is
   * absent simply offers no queued withdrawal, and
   * `vault.validateCompatibility({ requireQueue: true })` is how a caller that
   * needs one says so.
   */
  queueProgramAddress?: string;
  /**
   * `hook_program` — the Token-2022 transfer hook on the share mint. Required:
   * share transfers (including the ones a deposit and a withdrawal perform)
   * route through it, so a deployment without it cannot move shares at all.
   */
  hookProgramAddress: string;
  /**
   * The vault-state accounts SDP catalogues on this cluster.
   *
   * An explicit allowlist, never a program-account census. Veda vaults are
   * deployed per customer, so the program's account set includes other
   * integrators' vaults; enumerating it would put someone else's vault on SDP's
   * shelf. It is also what makes `riskMetadata` and `sourceKind` defensible —
   * every catalogued row traces to an address Veda named, which is the same bar
   * the Kamino curator rule sets (see `packages/sdp-earn/CLAUDE.md`).
   */
  vaultStateAddresses: readonly string[];
}

/**
 * Deposit assets SDP is willing to front for Veda, as token SYMBOLS.
 *
 * Declared cluster-agnostically and bridged to mints through the well-known
 * token catalogue, matching EarnDeclaredStrategySupport. USDC and OUSD are
 * the production PRIME assets; only USDC has a confirmed devnet mint.
 *
 * This is a CEILING, not a promise. The live vault decides what it accepts; the
 * catalogue intersects the two, so widening this never admits an asset the
 * vault has disabled.
 */
export const VEDA_DEPOSIT_TOKEN_SYMBOLS = [
  "USDC",
  "OUSD",
] as const satisfies readonly EarnDepositTokenSymbol[];

/**
 * Production vault identities supplied by Veda for SDP (November 2026).
 * Names are provider-supplied; asset selection is pinned per vault so adding
 * OUSD never makes a multi-asset vault's deposit or position ambiguous.
 *
 * The asset is pinned by SYMBOL and resolved through the well-known token
 * catalogue, per the code standards: a mint address is written exactly once,
 * in `WELL_KNOWN_TOKENS`, and these pins read it from there.
 */
const VEDA_MAINNET_VAULT_IDENTITIES = [
  {
    name: "USDC PRIME",
    assetSymbol: "USDC",
    // biome-ignore lint/security/noSecrets: public vault state account.
    vaultStateAddress: "7PjRdSecsdyUaasPqsQSDyBz67FMJPZT82KCkpXCb1sy",
    vaultId: 4,
    // biome-ignore lint/security/noSecrets: public vault share mint.
    shareMint: "78gitz5xcQUuV7CfYDBMSKpYVqazDWyRZ2KhQjqFZMjh",
  },
  {
    name: "OUSD PRIME",
    assetSymbol: "OUSD",
    // biome-ignore lint/security/noSecrets: public vault state account.
    vaultStateAddress: "5qXvYYBRWwW9JYgFAfu3TpWLRaeJ31sEWNWW2cSvU8ZV",
    vaultId: 5,
    // biome-ignore lint/security/noSecrets: public vault share mint.
    shareMint: "DZZa8WVtkDv281vg8nKawhBjpmTxtNkKJdmciw71ZcP9",
  },
] as const satisfies readonly {
  name: string;
  assetSymbol: WellKnownTokenSymbol;
  vaultStateAddress: string;
  vaultId: number;
  shareMint: string;
}[];

/**
 * The mainnet mint the well-known catalogue carries for a pinned vault asset.
 *
 * Throws rather than returning `undefined` on purpose: a vault pin naming a
 * token the registry does not deploy on mainnet is a programmer error that
 * must fail loudly at module load, not silently widen into "accepts no mints".
 */
function mainnetVaultMint(symbol: WellKnownTokenSymbol): string {
  const mint = wellKnownMint(symbol, "mainnet-beta");
  if (mint === undefined) {
    throw new Error(`The well-known token registry carries no mainnet-beta mint for ${symbol}`);
  }
  return mint;
}

export const VEDA_MAINNET_VAULTS = VEDA_MAINNET_VAULT_IDENTITIES.map((vault) => ({
  ...vault,
  assetMint: mainnetVaultMint(vault.assetSymbol),
}));

export function vedaVaultMetadata(cluster: SolanaCluster, vault: string) {
  return cluster === "mainnet-beta"
    ? VEDA_MAINNET_VAULTS.find((entry) => entry.vaultStateAddress === vault)
    : undefined;
}

/**
 * Per-cluster deployment, or `null` when SDP has no confirmed one.
 *
 * A missing deployment fails closed at the provider boundary.
 */
export const VEDA_DEPLOYMENTS: Readonly<Record<SolanaCluster, VedaDeployment | null>> = {
  "mainnet-beta": {
    // biome-ignore lint/security/noSecrets: public vault program.
    vaultProgramAddress: "9TWFuaFP1pvx698ANRpiGBHqi6zrTFBQoXwqaAmfd5Jp",
    // biome-ignore lint/security/noSecrets: public BoringQueue program.
    queueProgramAddress: "A4g8EPHbe2GgydQcKaEAv6VkB6Tyz6utcADcMtDwnaqy",
    // biome-ignore lint/security/noSecrets: public transfer-hook program.
    hookProgramAddress: "4aHAutB42cB5qVuj8BDowezi3EwX6yPasaDmTqMEEtta",
    vaultStateAddresses: VEDA_MAINNET_VAULTS.map((vault) => vault.vaultStateAddress),
  },
  // Veda's devnet Test Vault deployment, from their integration docs and
  // measured on chain. Production uses its own programs and vaults.
  devnet: {
    // biome-ignore lint/security/noSecrets: on-chain program address, not a secret.
    vaultProgramAddress: "ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J",
    // biome-ignore lint/security/noSecrets: on-chain program address, not a secret.
    queueProgramAddress: "fh8uapqMe4GWhep9rt9qZ56Pxi9SYszkuDKXckYMQTT",
    // biome-ignore lint/security/noSecrets: on-chain program address, not a secret.
    hookProgramAddress: "BmTjMtZGcvx5XB7LwRaGq3x9hdHG1SziYikjP9BAgoE2",
    // biome-ignore lint/security/noSecrets: on-chain account address, not a secret.
    vaultStateAddresses: ["3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU"],
  },
};

/**
 * The deployment for one cluster, or `null`.
 *
 * Takes a CLUSTER, never an `SdpEnvironment`. Callers holding an environment
 * convert with `CLUSTER_BY_SDP_ENVIRONMENT` at the boundary — "environment
 * implies cluster" is the assumption migration 0057 and `host_cluster` exist to
 * stop, and a provider whose devnet and mainnet deployments may share addresses
 * is exactly where that assumption would go unnoticed.
 */
export function vedaDeployment(cluster: SolanaCluster): VedaDeployment | null {
  return VEDA_DEPLOYMENTS[cluster] ?? null;
}

/** True when SDP has a confirmed Veda deployment for this cluster. */
export function isVedaDeployed(cluster: SolanaCluster): boolean {
  return vedaDeployment(cluster) !== null;
}

/**
 * The mints SDP will front for Veda on one cluster, resolved from the symbols
 * above through the well-known token catalogue.
 *
 * Fails closed by omission: a symbol with no mint on this cluster (USDT has no
 * devnet mint, for instance) simply contributes nothing, rather than producing
 * a mint address that does not exist there.
 */
export function vedaDepositMints(cluster: SolanaCluster): readonly string[] {
  return VEDA_DEPOSIT_TOKEN_SYMBOLS.map((symbol) => wellKnownMint(symbol, cluster)).filter(
    (mint): mint is string => mint !== undefined
  );
}

/**
 * Whether SDP fronts this mint for Veda ON THIS CLUSTER — the admission rule,
 * in ONE place.
 *
 * Two very different code paths ask it and they must never disagree: the
 * catalogue read in `@sdp/earn` decides which of a vault's enabled assets
 * become a row's `depositMints`, and the builder in `@sdp/veda` decides which
 * asset a deposit instruction spends. A row admitted under one rule and spent
 * under another is how a deposit ends up moving a token the ledger did not
 * record, which is exactly what `EarnVaultAssetIdentity` exists to catch — and
 * a check that fires is still a customer-visible failure, so the two sides
 * share this predicate rather than each restating it.
 *
 * CLUSTER-AWARE by exact mint membership, never a symbol comparison. Mainnet
 * USDC and devnet USDC share a symbol but are different mints, so a
 * symbol-level check would admit the OTHER cluster's mint — a devnet vault
 * whose asset config named mainnet USDC would catalogue (and try to spend) a
 * mint that does not exist on devnet, failing only downstream as "account not
 * found".
 *
 * Fails closed on an unknown mint: a mint the well-known catalogue does not
 * carry is not something SDP fronts anywhere.
 */
export function isVedaDepositMint(mint: string, cluster: SolanaCluster, vault: string): boolean {
  const configured = vedaVaultMetadata(cluster, vault);
  if (configured) return mint === configured.assetMint;
  return vedaDepositMints(cluster).includes(mint);
}

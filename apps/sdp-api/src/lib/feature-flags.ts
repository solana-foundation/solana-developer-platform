import type { CustodyProvider } from "@sdp/custody";
import { type FeePaymentEnv, isFeePaymentConfiguredForCluster } from "@sdp/payments/fee-payment";
import {
  isModuleInReleaseChannel,
  isRampProviderInReleaseChannel,
  type RampProviderId,
  resolveSdpReleaseChannel,
  SDP_RAMP_PROVIDER_STAGES,
  type SdpModule,
  type SdpRampProviderStages,
  type SolanaCluster,
} from "@sdp/types";
import type { Env } from "@/types/env";
import { isSelfHostedDeployment } from "./runtime-env";

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Whether the deployment's release channel (`SDP_RELEASE_CHANNEL`, see `@sdp/types` release channels)
 * includes `module`. A release channel only caps: every flag below still has to be on,
 * and none of them can bring back a module the release channel leaves out.
 */
export function isModuleAvailable(
  env: Pick<Env, "SDP_RELEASE_CHANNEL">,
  module: SdpModule,
  rampProviderStages: SdpRampProviderStages
): boolean {
  return isModuleInReleaseChannel(
    resolveSdpReleaseChannel(env.SDP_RELEASE_CHANNEL),
    module,
    rampProviderStages
  );
}

/** Whether the deployment's release channel includes ramp `provider` (see `SDP_RAMP_PROVIDER_STAGES`). */
export function isRampProviderAvailable(
  env: Pick<Env, "SDP_RELEASE_CHANNEL">,
  provider: RampProviderId,
  rampProviderStages: SdpRampProviderStages
): boolean {
  return isRampProviderInReleaseChannel(
    resolveSdpReleaseChannel(env.SDP_RELEASE_CHANNEL),
    provider,
    rampProviderStages
  );
}

/**
 * Boot check: every deployment names a known release channel, so a forgotten variable
 * or a typo fails at startup instead of shipping every module. It does not read
 * `ENVIRONMENT`, so a job with a missing or wrong `ENVIRONMENT` is checked too.
 */
export function assertSdpReleaseChannelConfigured(env: Pick<Env, "SDP_RELEASE_CHANNEL">): void {
  resolveSdpReleaseChannel(env.SDP_RELEASE_CHANNEL);
}

export function isAssetProfilesEnabled(
  env: Pick<
    Env,
    "SDP_FLAG_ASSET_PROFILES" | "ENVIRONMENT" | "SDP_DEPLOYMENT_MODE" | "SDP_RELEASE_CHANNEL"
  >
): boolean {
  if (!isModuleAvailable(env, "issuance", SDP_RAMP_PROVIDER_STAGES)) {
    return false;
  }
  // Managed SDP rolls out the UI through Vercel's `asset-profiles` flag. Keep
  // the authenticated API capability available so Cloud Run configuration
  // cannot drift from the web rollout. Self-hosted operators retain their
  // explicit environment opt-in because they do not depend on Vercel.
  if (!isSelfHostedDeployment(env)) {
    return true;
  }

  return env.ENVIRONMENT === "development" || isTruthyFlag(env.SDP_FLAG_ASSET_PROFILES);
}

export function isPrivateChannelsEnabled(
  env: Pick<Env, "PRIVATE_CHANNELS_ENABLED" | "SDP_RELEASE_CHANNEL">
): boolean {
  return (
    isModuleAvailable(env, "private_channels", SDP_RAMP_PROVIDER_STAGES) &&
    isTruthyFlag(env.PRIVATE_CHANNELS_ENABLED)
  );
}

export function isHeliusRingsEnabled(
  env: Pick<Env, "HELIUS_RINGS_ENABLED" | "SDP_RELEASE_CHANNEL">
): boolean {
  return (
    isModuleAvailable(env, "helius_rings", SDP_RAMP_PROVIDER_STAGES) &&
    isTruthyFlag(env.HELIUS_RINGS_ENABLED)
  );
}

export function isPrivyByokEnabled(env: Pick<Env, "PRIVY_BYOK_ENABLED">): boolean {
  return isTruthyFlag(env.PRIVY_BYOK_ENABLED);
}

export function isCustodyConnectionRuntimeEnabled(
  env: Pick<Env, "PRIVY_BYOK_ENABLED">,
  provider: CustodyProvider
): boolean {
  return provider === "privy" && isPrivyByokEnabled(env);
}

export type CustodySetupMethod = "legacy_config" | "stored_credentials" | "deployment_credentials";

export function resolveNewCustodySetupMethod(
  env: Pick<
    Env,
    "PRIVY_BYOK_ENABLED" | "SDP_DEPLOYMENT_MODE" | "SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED"
  >,
  provider: CustodyProvider
): CustodySetupMethod {
  if (!isCustodyConnectionRuntimeEnabled(env, provider)) {
    return "legacy_config";
  }
  if (!isSelfHostedDeployment(env)) {
    return "stored_credentials";
  }
  return isTruthyFlag(env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED)
    ? "stored_credentials"
    : "deployment_credentials";
}

export function isMarketsEnabled(
  env: Pick<Env, "MARKETS_ENABLED" | "SDP_RELEASE_CHANNEL">
): boolean {
  return (
    isModuleAvailable(env, "markets", SDP_RAMP_PROVIDER_STAGES) && isTruthyFlag(env.MARKETS_ENABLED)
  );
}

// Earn is a sub-module of Markets, so the parent flag gates it: clearing
// MARKETS_ENABLED disables every Markets API surface in one move. Callers must
// not add a second markets check — this hierarchy is the single source of truth.
export function isEarnEnabled(
  env: Pick<Env, "MARKETS_ENABLED" | "EARN_ENABLED" | "SDP_RELEASE_CHANNEL">
): boolean {
  return (
    isMarketsEnabled(env) &&
    isModuleAvailable(env, "earn", SDP_RAMP_PROVIDER_STAGES) &&
    isTruthyFlag(env.EARN_ENABLED)
  );
}

// DvP is the other Markets sub-module. It has no flag of its own on the API, so
// Markets plus the release channel decide it.
export function isDvpEnabled(env: Pick<Env, "MARKETS_ENABLED" | "SDP_RELEASE_CHANNEL">): boolean {
  return isMarketsEnabled(env) && isModuleAvailable(env, "dvp", SDP_RAMP_PROVIDER_STAGES);
}

/**
 * Whether the rollout switch for Hastra's optional PRIME -> wYLDS -> Jupiter
 * -> USDC exit is on. Off by default: Hastra's operator-settled par redemption
 * remains the default exit rail and is intentionally independent from it.
 */
export function isEarnHastraDexExitEnabled(
  env: Pick<Env, "EARN_HASTRA_DEX_EXIT_ENABLED">
): boolean {
  return isTruthyFlag(env.EARN_HASTRA_DEX_EXIT_ENABLED);
}

/**
 * Whether this deployment can actually offer the optional Hastra DEX rail.
 * The rollout switch is the product decision; the Jupiter key is the runtime
 * prerequisite. Keeping both here prevents withdrawal-options and strategy
 * metadata from advertising a route whose builder cannot authenticate.
 */
export function isEarnHastraDexExitConfigured(
  env: Pick<Env, "EARN_HASTRA_DEX_EXIT_ENABLED" | "JUPITER_SWAP_API_KEY">
): boolean {
  return (
    isEarnHastraDexExitEnabled(env) &&
    typeof env.JUPITER_SWAP_API_KEY === "string" &&
    env.JUPITER_SWAP_API_KEY.trim().length > 0
  );
}

/**
 * Whether Kora sponsors an Earn vault movement on `cluster`: both the network
 * fee and the share-ATA rent a first deposit needs.
 *
 * TAKES THE CLUSTER, and that is the whole point rather than an extra
 * parameter. One API process serves both clusters at once (a sandbox project is
 * devnet, a production project is mainnet-beta), deposits are environment-gated
 * but WITHDRAWALS DELIBERATELY ARE NOT (ADR 0002 forbids money-out inheriting a
 * money-in gate), and both directions share one fee decision. A single
 * deployment-global boolean would therefore flip mainnet withdrawals to
 * sponsored at the instant devnet deposits were enabled, against a paymaster
 * that may not exist for that cluster: a 5xx on a customer's exit path, which
 * is the one failure ADR 0002 rules out.
 *
 * Which clusters are sponsored is CONFIGURATION, not a list in code: the flag
 * must be on AND the deployment must have a fee payer for the cluster
 * (`isFeePaymentConfiguredForCluster`: `KORA_RPC_URL` for the process network,
 * `KORA_RPC_URL_MAINNET` / `KORA_RPC_URL_DEVNET` for the other). Opening
 * mainnet is therefore wiring the mainnet Kora into the deployment, after its
 * `fee_payer_policy` is opened and `sbp_mainnet_global` is enabled (PRO-1738);
 * closing it is removing that wiring, with no code change either way.
 *
 * Fail-closed on both axes: an unconfigured flag and an unconfigured cluster
 * each answer false, and callers fall back to the wallet paying its own way.
 */
export function isEarnVaultSponsorshipEnabled(
  env: Pick<Env, "EARN_VAULT_FEE_SPONSORSHIP_ENABLED"> & FeePaymentEnv,
  cluster: SolanaCluster
): boolean {
  if (!isTruthyFlag(env.EARN_VAULT_FEE_SPONSORSHIP_ENABLED)) return false;
  return isFeePaymentConfiguredForCluster(env, cluster);
}

/**
 * Whether the Earn volume caps (ADR 0004) REFUSE, or only observe.
 *
 * Off (the default) is SHADOW MODE: every cap still evaluates on every deposit
 * admission and emits `sdp_api_earn_volume_cap_evaluated` with `would_block`,
 * but nothing is refused and no preview reports a blocking issue. Defaults
 * are set from that shadow data, then this flips. Deliberately a plain
 * truthy flag with no cluster narrowing, unlike sponsorship: a cap is a
 * platform posture, not a per-cluster capability, and the caps themselves
 * are already keyed by cluster in `handlers/curation.ts`.
 *
 * Fail-closed reads of the cap INPUTS do not consult this: an exposure read
 * that throws refuses the deposit in shadow mode too (ADR 0004, "fail closed
 * on deposits, never on exits").
 */
export function isEarnVolumeCapsEnforced(env: Pick<Env, "EARN_VOLUME_CAPS_ENFORCED">): boolean {
  return isTruthyFlag(env.EARN_VOLUME_CAPS_ENFORCED);
}

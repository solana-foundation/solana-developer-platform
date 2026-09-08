import type { CustodyProvider } from "@sdp/custody";
import type { SolanaCluster } from "@sdp/types";
import type { Env } from "@/types/env";
import { isSelfHostedDeployment } from "./runtime-env";

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isAssetProfilesEnabled(
  env: Pick<Env, "SDP_FLAG_ASSET_PROFILES" | "ENVIRONMENT" | "SDP_DEPLOYMENT_MODE">
): boolean {
  // Managed SDP rolls out the UI through Vercel's `asset-profiles` flag. Keep
  // the authenticated API capability available so Cloud Run configuration
  // cannot drift from the web rollout. Self-hosted operators retain their
  // explicit environment opt-in because they do not depend on Vercel.
  if (!isSelfHostedDeployment(env)) {
    return true;
  }

  return env.ENVIRONMENT === "development" || isTruthyFlag(env.SDP_FLAG_ASSET_PROFILES);
}

export function isPrivateChannelsEnabled(env: Pick<Env, "PRIVATE_CHANNELS_ENABLED">): boolean {
  return isTruthyFlag(env.PRIVATE_CHANNELS_ENABLED);
}

export function isHeliusRingsEnabled(env: Pick<Env, "HELIUS_RINGS_ENABLED">): boolean {
  return isTruthyFlag(env.HELIUS_RINGS_ENABLED);
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

export function isMarketsEnabled(env: Pick<Env, "MARKETS_ENABLED">): boolean {
  return isTruthyFlag(env.MARKETS_ENABLED);
}

// Earn is a sub-module of Markets, so the parent flag gates it: clearing
// MARKETS_ENABLED disables every Markets API surface in one move. Callers must
// not add a second markets check — this hierarchy is the single source of truth.
export function isEarnEnabled(env: Pick<Env, "MARKETS_ENABLED" | "EARN_ENABLED">): boolean {
  return isMarketsEnabled(env) && isTruthyFlag(env.EARN_ENABLED);
}

/**
 * Clusters on which Kora may pay for Earn vault movements.
 *
 * TO OPEN MAINNET, all three must be in place, and none is a flag flip:
 * the Kamino program ids must reach `kora.mainnet.toml`'s `allowed_programs`
 * (landed with sdp-infra#64);
 * `fee_payer_policy.system.allow_create_account` must be opened there (today
 * `validate-policy.py` runs with no `--allow-spend` for mainnet and hard-fails
 * CI on any `true`), which is deliberately deferred until compensated pricing
 * ships; and `sbp_mainnet_global.enabled` must be turned on. Opening the policy
 * without also lowering `max_allowed_lamports` below 10,000,000 would push the
 * per-transaction reservation past the seeded budget and deny ALL sponsorship,
 * payments and issuance included.
 */
const EARN_VAULT_SPONSORSHIP_CLUSTERS: readonly SolanaCluster[] = ["devnet"];

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
 * sponsored at the instant devnet deposits were enabled, against a mainnet Kora
 * that allowlists no Kamino program and a disabled mainnet budget policy: a 5xx
 * on a customer's exit path, which is the one failure ADR 0002 rules out.
 *
 * Fail-closed on both axes: an unconfigured flag and an unlisted cluster each
 * answer false, and callers fall back to the wallet paying its own way.
 */
export function isEarnVaultSponsorshipEnabled(
  env: Pick<Env, "EARN_VAULT_FEE_SPONSORSHIP_ENABLED">,
  cluster: SolanaCluster
): boolean {
  if (!EARN_VAULT_SPONSORSHIP_CLUSTERS.includes(cluster)) return false;
  return isTruthyFlag(env.EARN_VAULT_FEE_SPONSORSHIP_ENABLED);
}

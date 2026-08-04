import type { Env } from "@/types/env";
import { isSelfHostedDeployment } from "./runtime-env";

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isRecurringPaymentCollectionEnabled(
  env: Pick<Env, "PAYMENTS_RECURRING_COLLECTION_ENABLED">
): boolean {
  return isTruthyFlag(env.PAYMENTS_RECURRING_COLLECTION_ENABLED);
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

export function isPrivyByokEnabled(env: Pick<Env, "PRIVY_BYOK_ENABLED">): boolean {
  return isTruthyFlag(env.PRIVY_BYOK_ENABLED);
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

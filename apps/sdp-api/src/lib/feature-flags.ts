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
  env: Pick<Env, "ASSET_PROFILES_ENABLED" | "ENVIRONMENT" | "SDP_DEPLOYMENT_MODE">
): boolean {
  // Managed SDP rolls out the UI through Vercel's `asset-profiles` flag. Keep
  // the authenticated API capability available so Cloud Run configuration
  // cannot drift from the web rollout. Self-hosted operators retain their
  // explicit environment opt-in because they do not depend on Vercel.
  if (!isSelfHostedDeployment(env)) {
    return true;
  }

  return env.ENVIRONMENT === "development" || isTruthyFlag(env.ASSET_PROFILES_ENABLED);
}

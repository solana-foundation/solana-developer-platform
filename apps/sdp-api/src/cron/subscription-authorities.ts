import { revokeIdleSubscriptionAuthorities } from "@/services/payments/recurring-payments/authority-revocation";
import type { Env } from "@/types/env";
import { alwaysEnabled, defineCron } from "./define-cron";

/**
 * Revoke the open cluster scope's idle Subscriptions authorities.
 *
 * @param env - Process environment.
 * @returns Resolves once this run's revokes have settled or been left for the next run.
 */
async function revokeIdleNow(env: Env): Promise<void> {
  await revokeIdleSubscriptionAuthorities(env, new Date());
}

/**
 * Subscriptions authority cleanup (HOO-2210): revokes a wallet's per-mint delegation to the
 * Subscriptions program once every recurring payment on it has ended. Hourly: an authority waits a
 * full billing period after its last cancel anyway.
 */
export const subscriptionAuthoritiesCron = defineCron({
  name: "revoke-subscription-authorities",
  schedule: "23 * * * *",
  scope: "cluster",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: revokeIdleNow,
});

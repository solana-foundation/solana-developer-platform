import { UNIFIED_TRANSACTION_MODULES, type UnifiedTransactionModule } from "@sdp/types";

/**
 * The published-module allowlist while Earn is held back. Deliberately an
 * explicit allowlist, not a runtime filter: a module added to
 * `UNIFIED_TRANSACTION_MODULES` stays out of the held-back public contract
 * until it is added here, which is the fail-closed direction for a
 * publication boundary. `publishEarn: true` (the internal document and the
 * publishable document after PRO-2038) bypasses the allowlist and publishes
 * the full runtime list.
 */
export const PUBLISHED_TRANSACTION_MODULES_WITHOUT_EARN = [
  "payments",
  "dvp",
  "private_channels",
  "issuance",
  "rings",
] as const satisfies readonly UnifiedTransactionModule[];

export function publishedTransactionModules(
  publishEarn: boolean
): typeof UNIFIED_TRANSACTION_MODULES | typeof PUBLISHED_TRANSACTION_MODULES_WITHOUT_EARN {
  return publishEarn ? UNIFIED_TRANSACTION_MODULES : PUBLISHED_TRANSACTION_MODULES_WITHOUT_EARN;
}

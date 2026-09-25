import { UNIFIED_TRANSACTION_MODULES, type UnifiedTransactionModule } from "@sdp/types";

/**
 * The published-module allowlist while Earn is held back. Deliberately an
 * explicit allowlist, and a document boundary only — the runtime never reads
 * it: a module added to `UNIFIED_TRANSACTION_MODULES` stays out of the
 * held-back public contract until it is added here, which is the fail-closed
 * direction for a publication boundary. `publishEarn: true` (the internal
 * document and the publishable document after PRO-2038) bypasses the
 * allowlist and publishes the full runtime list. Consumers:
 * `openapi/paths/transactions.ts` (the module selector and response union) —
 * an unfiltered read can still return held-back rows to an authorized
 * caller, so the published response union carries the module-agnostic
 * variant (`unpublishedModuleTransactionSchema` in `./schemas`) that
 * describes them without naming them.
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

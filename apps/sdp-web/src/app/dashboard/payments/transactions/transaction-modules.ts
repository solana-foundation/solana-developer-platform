import { UNIFIED_TRANSACTION_MODULES, type UnifiedTransactionModule } from "@sdp/types";
import type { DashboardFlags } from "@/flags/dashboard";

export type TransactionModuleFlags = Pick<
  DashboardFlags,
  "dvp" | "earn" | "heliusRings" | "issuance" | "markets" | "payments" | "privateChannels"
>;

/** Whether each transaction module's dashboard area is on, mirroring the sidebar. */
const TRANSACTION_MODULE_ENABLED = {
  payments: (flags) => flags.payments,
  earn: (flags) => flags.markets && flags.earn,
  dvp: (flags) => flags.markets && flags.dvp,
  private_channels: (flags) => flags.privateChannels,
  issuance: (flags) => flags.issuance,
  rings: (flags) => flags.heliusRings,
} as const satisfies Record<UnifiedTransactionModule, (flags: TransactionModuleFlags) => boolean>;

/**
 * The transaction modules the dashboard shows tabs and filters for. A module's flag is
 * already capped at the release channel, so a module the channel leaves out is never listed.
 *
 * @param flags - The dashboard's flag snapshot.
 * @returns The enabled modules, in tab order.
 */
export function enabledTransactionModules(
  flags: TransactionModuleFlags
): UnifiedTransactionModule[] {
  return UNIFIED_TRANSACTION_MODULES.filter((module) => TRANSACTION_MODULE_ENABLED[module](flags));
}

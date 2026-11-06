import {
  PAYMENT_TRANSACTION_KINDS,
  type PaymentTransactionKind,
  // biome-ignore lint/style/noRestrictedImports: this is the gated list; it filters the tuple by the channel-capped flags
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types/unified-transactions";
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

/**
 * Whether the dashboard offers each Payments kind: a ramp only where the channel runs Ramps,
 * and a confidential payment nowhere yet, since no transfer type records one
 * (`PAYMENT_TRANSFER_TYPES` has no confidential transfer).
 */
const PAYMENT_KIND_ENABLED = {
  pay: () => true,
  confidential_pay: () => false,
  batch_pay: () => true,
  recurring_pay: () => true,
  deposit: () => true,
  request_deposit: () => true,
  onramp: (flags) => flags.ramps,
  offramp: (flags) => flags.ramps,
} as const satisfies Record<
  PaymentTransactionKind,
  (flags: Pick<DashboardFlags, "ramps">) => boolean
>;

/**
 * The Payments kinds the Type filter offers: the module's contract, less the kinds this
 * deployment can never record.
 *
 * @param flags - The dashboard's flag snapshot.
 * @returns The offered kinds, in contract order.
 */
export function enabledPaymentTransactionKinds(
  flags: Pick<DashboardFlags, "ramps">
): PaymentTransactionKind[] {
  return PAYMENT_TRANSACTION_KINDS.filter((kind) => PAYMENT_KIND_ENABLED[kind](flags));
}

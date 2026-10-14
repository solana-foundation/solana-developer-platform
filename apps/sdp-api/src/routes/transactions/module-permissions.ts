import {
  type Action,
  type Permission,
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types";

/**
 * The action that shows each module's rows in the unified list. Payments rows
 * are what the route's own action (`transactions.read`) covers; every other
 * module's rows also need that module's read.
 */
export const UNIFIED_TRANSACTION_MODULE_ACTIONS = {
  payments: "transactions.read",
  earn: "earn.read",
  dvp: "dvp.read",
  private_channels: "private_channels.read",
  issuance: "issuance.read",
  rings: "helius_rings.read",
} as const satisfies Record<UnifiedTransactionModule, Action>;

/**
 * The wallet-binding permission that scopes each module's rows to a key's
 * selected wallets. Wallet bindings keep the permission vocabulary until the
 * wallet-scope work replaces it.
 */
export const UNIFIED_TRANSACTION_MODULE_PERMISSIONS = {
  payments: "payments:read",
  earn: "earn:read",
  dvp: "wallets:read",
  private_channels: "payments:read",
  issuance: "tokens:read",
  rings: "payments:read",
} as const satisfies Record<UnifiedTransactionModule, Permission>;

/** The modules whose rows a caller may see, given whether it may perform each action. */
export function permittedUnifiedTransactionModules(
  mayPerform: (action: Action) => boolean
): UnifiedTransactionModule[] {
  return UNIFIED_TRANSACTION_MODULES.filter((module) =>
    mayPerform(UNIFIED_TRANSACTION_MODULE_ACTIONS[module])
  );
}

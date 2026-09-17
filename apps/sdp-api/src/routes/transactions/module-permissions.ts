import {
  type Permission,
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types";

export const UNIFIED_TRANSACTION_MODULE_PERMISSIONS = {
  payments: "payments:read",
  earn: "earn:read",
  dvp: "wallets:read",
  private_channels: "payments:read",
  issuance: "tokens:read",
  rings: "payments:read",
} as const satisfies Record<UnifiedTransactionModule, Permission>;

export function permittedUnifiedTransactionModules(
  granted: readonly Permission[] | "*"
): UnifiedTransactionModule[] {
  return UNIFIED_TRANSACTION_MODULES.filter(
    (module) => granted === "*" || granted.includes(UNIFIED_TRANSACTION_MODULE_PERMISSIONS[module])
  );
}

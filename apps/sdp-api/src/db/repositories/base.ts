export type { DatabaseClient as RepositoryDbClient } from "@/db";

/**
 * Wallet-level visibility for Private Channels history reads, resolved from
 * the authenticated API key's wallet bindings for a permission: `all`
 * (unrestricted — sessions and all-wallet keys), `selected` (only rows whose
 * wallet is in `walletIds`), or `none` (no rows at all). A selected key's
 * history reads must never widen past its bindings (SOLA9-518).
 */
export type PrivateChannelHistoryWalletScope =
  | { scope: "all" }
  | { scope: "selected"; walletIds: string[] }
  | { scope: "none" };

import type { UnifiedTransactionSource } from "./types";

/**
 * Helius Rings operations in the unified ledger. `to_addr` is not one
 * counterparty column: it is the wallet's own shielded address for a shield,
 * the recipient only for a transfer or withdrawal, and unset for merges,
 * timelocks and zones. Until a per-operation rule is agreed the row names no
 * other party and `counterparty_address` is NULL.
 */
export const ringsUnifiedTransactionSource = {
  sql: () => `SELECT
  o.id,
  o.id AS module_id,
  o.op_type AS kind,
  o.state AS module_status,
  o.organization_id,
  o.project_id,
  wallet.custody_wallet_id,
  o.asset_mint AS token,
  trim_scale(o.amount_raw::numeric / (10::numeric ^ al.decimals))::text AS amount,
  NULL::text AS counterparty_id,
  NULL::text AS counterparty_address,
  o.outer_tx_signature AS signature,
  o.created_at
FROM helius_rings_operations o
JOIN helius_rings_wallets wallet ON wallet.id = o.wallet_id AND wallet.organization_id = o.organization_id AND wallet.project_id = o.project_id
LEFT JOIN helius_rings_asset_allowlist al ON al.mint = o.asset_mint`,
} as const satisfies UnifiedTransactionSource;

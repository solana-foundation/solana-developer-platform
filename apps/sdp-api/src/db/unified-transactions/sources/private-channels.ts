import type { UnifiedTransactionSource } from "./types";

const PRIVATE_CHANNEL_LEDGERS = {
  private_channel_transfers: "transfer",
  private_channel_deposits: "deposit",
  private_channel_withdrawals: "withdraw",
} as const;

export const privateChannelsUnifiedTransactionSource = {
  sql: () =>
    Object.entries(PRIVATE_CHANNEL_LEDGERS)
      .map(
        ([table, kind]) =>
          `SELECT id, id AS module_id, '${kind}' AS kind, status AS module_status, organization_id, project_id, NULL::text AS custody_wallet_id, mint AS token, amount, NULL::text AS counterparty_id, signature, created_at FROM ${table}`
      )
      .join("\nUNION ALL\n"),
} as const satisfies UnifiedTransactionSource;

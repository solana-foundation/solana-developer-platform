import type { UnifiedTransactionSource } from "./types";

// Only a channel transfer names another party: `sender_wallet_id` is the SDP
// wallet, so `recipient` is the counterparty's channel-chain address. A deposit
// moves the wallet's own funds onto the channel chain and a withdrawal releases
// them back, so neither row has a counterparty.
const PRIVATE_CHANNEL_LEDGERS = {
  private_channel_transfers: { kind: "transfer", counterpartyAddress: "recipient" },
  private_channel_deposits: { kind: "deposit", counterpartyAddress: "NULL::text" },
  private_channel_withdrawals: { kind: "withdraw", counterpartyAddress: "NULL::text" },
} as const;

export const privateChannelsUnifiedTransactionSource = {
  sql: () =>
    Object.entries(PRIVATE_CHANNEL_LEDGERS)
      .map(
        ([table, ledger]) =>
          `SELECT id, id AS module_id, '${ledger.kind}' AS kind, status AS module_status, organization_id, project_id, NULL::text AS custody_wallet_id, mint AS token, amount, NULL::text AS counterparty_id, ${ledger.counterpartyAddress} AS counterparty_address, signature, created_at FROM ${table}`
      )
      .join("\nUNION ALL\n"),
} as const satisfies UnifiedTransactionSource;

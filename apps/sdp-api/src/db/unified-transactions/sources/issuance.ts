import type { UnifiedTransactionSource } from "./types";

export const issuanceUnifiedTransactionSource = {
  sql: () => `SELECT
  it.id,
  it.id AS module_id,
  it.type AS kind,
  it.status AS module_status,
  it.organization_id,
  tok.project_id,
  it.custody_wallet_id,
  tok.mint_address AS token,
  NULL::text AS amount,
  NULL::text AS counterparty_id,
  it.signature,
  it.created_at
FROM issuance_transactions it
JOIN issued_tokens tok ON tok.id = it.token_id`,
} as const satisfies UnifiedTransactionSource;

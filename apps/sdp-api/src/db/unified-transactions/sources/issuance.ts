import type { UnifiedTransactionSource } from "./types";

// Value-moving kinds (mint, burn, seize, force_burn) persist the exact decimal
// in operation_params.amount; lifecycle-only kinds have none. operation_params
// is TEXT, so the extraction is guarded: malformed or legacy rows project NULL
// instead of aborting the unified view, and only plain unsigned decimals are
// projected. The matcher mirrors isDecimalString (the grammar the issuance
// routes validate amounts with): digits with at most one decimal point and at
// least one digit, including leading-dot (".5") and trailing-dot ("1.") forms.
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
  CASE
    WHEN it.type IN ('mint', 'burn', 'seize', 'force_burn')
      AND pg_input_is_valid(it.operation_params, 'jsonb')
      AND it.operation_params::jsonb ->> 'amount' ~ '^(\\d+(\\.\\d*)?|\\.\\d+)$'
    THEN it.operation_params::jsonb ->> 'amount'
    ELSE NULL
  END AS amount,
  NULL::text AS counterparty_id,
  it.signature,
  it.created_at
FROM issuance_transactions it
JOIN issued_tokens tok ON tok.id = it.token_id`,
} as const satisfies UnifiedTransactionSource;

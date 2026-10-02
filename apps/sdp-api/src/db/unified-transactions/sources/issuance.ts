import type { UnifiedTransactionSource } from "./types";

/**
 * Issuance operations in the unified ledger.
 *
 * `operation_params` is a TEXT column (no CHECK) holding the operation's
 * request inputs as JSON. Both writers — TokenService `createTransaction` and
 * `updateTransaction` — store `JSON.stringify(params)`, so a plain `::jsonb`
 * cast holds for every row SDP wrote. The `pg_input_is_valid` guard (PG16+)
 * copies the one TokenService's wallet scan uses: a stray malformed row reads
 * as NULL instead of aborting every read of the feed, and CASE only evaluates
 * the cast once the guard passes.
 *
 * `amount` is the request's decimal string in token units: the issuance
 * schemas validate it with `isDecimalString`, and TokenService multiplies it
 * by 10^decimals to reach base units. That is the unit
 * `UnifiedTransactionCommon.amount` documents. Lifecycle operations (freeze,
 * pause, authority, deploy) carry no amount and stay NULL.
 *
 * The counterparty is the first account the operation names, in the order the
 * dashboard resolves it: a burn's or seizure's `source`, a mint's or seizure's
 * `destination`, the frozen `accountAddress`, a mint's `tokenAccount`, then
 * the authority rotation pair.
 */
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
  params.value ->> 'amount' AS amount,
  NULL::text AS counterparty_id,
  COALESCE(
    params.value ->> 'source',
    params.value ->> 'destination',
    params.value ->> 'accountAddress',
    params.value ->> 'tokenAccount',
    params.value ->> 'currentAuthority',
    params.value ->> 'newAuthority'
  ) AS counterparty_address,
  it.signature,
  it.created_at
FROM issuance_transactions it
JOIN issued_tokens tok ON tok.id = it.token_id
CROSS JOIN LATERAL (
  SELECT CASE WHEN pg_input_is_valid(it.operation_params, 'jsonb') THEN it.operation_params::jsonb END AS value
) params`,
} as const satisfies UnifiedTransactionSource;

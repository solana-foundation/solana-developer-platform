import assert from "node:assert/strict";
import { it } from "node:test";
import { matchEndpoint } from "./match";

const TRANSACTIONS = ["fireblocks", "POST", "/v1/transactions"] as const;

const REFUSED_PROGRAM_CALLS = [
  ["signOnly false", '{"operation":"PROGRAM_CALL","extraParameters":{"signOnly":false}}'],
  ["signOnly omitted", '{"operation":"PROGRAM_CALL","extraParameters":{}}'],
  ["signOnly not a boolean", '{"operation":"PROGRAM_CALL","extraParameters":{"signOnly":"true"}}'],
  ["no extraParameters", '{"operation":"PROGRAM_CALL"}'],
  [
    "a second nested key that differs from signOnly only in case",
    '{"operation":"PROGRAM_CALL","extraParameters":{"signOnly":true,"SignOnly":false}}',
  ],
] as const;

const cases = [
  ["refuses an undeclared provider", "acme", "GET", "/v1/wallets", "", "provider_not_allowed"],
  ["refuses a non-canonical path", "privy", "GET", "/v1/./wallets", "", "endpoint_not_allowed"],
  [
    "refuses a path parameter outside its format",
    "fireblocks",
    "GET",
    "/v1/vault/accounts/vault-1",
    "",
    "endpoint_not_allowed",
  ],
  [
    "refuses an undeclared query name",
    "fireblocks",
    "GET",
    "/v1/vault/accounts_paged?other=1",
    "",
    "endpoint_not_allowed",
  ],
  ["refuses a wrong method", "privy", "POST", "/v1/wallets/wal_1", "", "endpoint_not_allowed"],
  [
    "refuses a body-rule value not allowed",
    ...TRANSACTIONS,
    '{"operation":"BURN"}',
    "body_not_allowed",
  ],
  [
    "refuses a second key that differs from the ruled field only in case",
    ...TRANSACTIONS,
    '{"operation":"RAW","Operation":"TRANSFER"}',
    "body_not_allowed",
  ],
  [
    "refuses a ruled body not in the exact form JSON.stringify writes",
    ...TRANSACTIONS,
    '{"operation":"BURN","operation":"TRANSFER"}',
    "body_not_allowed",
  ],
  [
    "allows a read with path parameters and a declared query name",
    "fireblocks",
    "GET",
    "/v1/vault/accounts/12/SOL_TEST/addresses_paginated?limit=5",
    "",
    "/v1/vault/accounts/{vault}/{asset}/addresses_paginated for api cron",
  ],
  ...REFUSED_PROGRAM_CALLS.map(
    ([what, body]) =>
      [`refuses PROGRAM_CALL with ${what}`, ...TRANSACTIONS, body, "body_not_allowed"] as const
  ),
  // Three endpoints share this method and path; the body picks the one whose callers apply.
  [
    "matches RAW to its own endpoint",
    ...TRANSACTIONS,
    '{"operation":"RAW"}',
    "/v1/transactions for api cron",
  ],
  [
    "matches a sign-only PROGRAM_CALL to its own endpoint",
    ...TRANSACTIONS,
    '{"operation":"PROGRAM_CALL","extraParameters":{"signOnly":true}}',
    "/v1/transactions for api cron",
  ],
  [
    "matches TRANSFER to its own endpoint",
    ...TRANSACTIONS,
    '{"operation":"TRANSFER"}',
    "/v1/transactions for api",
  ],
] as const;

for (const [name, provider, method, path, body, expected] of cases) {
  it(`matchEndpoint ${name}`, () => {
    const result = matchEndpoint({ provider, method, path, body });
    const got = result.allowed
      ? `${result.endpoint.path} for ${result.endpoint.callers.join(" ")}`
      : result.code;
    assert.equal(got, expected);
  });
}

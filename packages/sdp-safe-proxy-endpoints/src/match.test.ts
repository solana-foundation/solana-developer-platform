import assert from "node:assert/strict";
import { it } from "node:test";
import { matchEndpoint } from "./match";

const TRANSACTIONS = ["fireblocks", "POST", "/v1/transactions"] as const;

const cases = [
  ["refuses an undeclared provider", "acme", "GET", "/v1/wallets", "", "provider_not_allowed"],
  ["refuses a non-canonical path", "privy", "GET", "/v1/./wallets", "", "endpoint_not_allowed"],
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
  ["allows a Privy read", "privy", "GET", "/v1/wallets/wal_1", "", "read /v1/wallets/{wallet}"],
  [
    "allows a Fireblocks transfer",
    ...TRANSACTIONS,
    '{"operation":"TRANSFER"}',
    "change /v1/transactions",
  ],
] as const;

for (const [name, provider, method, path, body, expected] of cases) {
  it(`matchEndpoint ${name}`, () => {
    const result = matchEndpoint({ provider, method, path, body });
    const got = result.allowed ? `${result.endpoint.kind} ${result.endpoint.path}` : result.code;
    assert.equal(got, expected);
  });
}

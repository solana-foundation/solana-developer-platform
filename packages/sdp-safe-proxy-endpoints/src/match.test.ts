import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchEndpoint } from "./match";

function admit(provider: string, method: string, path: string, body = ""): string {
  const result = matchEndpoint({ provider, method, path, body });
  if (!result.allowed) return result.code;
  const { kind, path: declared, callers, body: rule } = result.endpoint;
  const picked = rule === undefined ? "" : ` ${rule.field}=${rule.values.join("|")}`;
  return `${result.provider} ${kind} ${declared}${picked} ${callers.join(",")}`;
}

const transaction = (body: string) => admit("fireblocks", "POST", "/v1/transactions", body);
const rpc = (body: string) => admit("privy", "POST", "/v1/wallets/wal_1/rpc", body);

describe("matchEndpoint", () => {
  it("refuses a provider that is not declared", () => {
    assert.equal(admit("acme", "GET", "/v1/wallets"), "provider_not_allowed");
  });

  it("allows a declared endpoint and returns its declaration", () => {
    assert.equal(
      admit("privy", "GET", "/v1/wallets/wal_1"),
      "privy read /v1/wallets/{wallet} api,cron"
    );
  });

  it("refuses a target that is not a whole declared path in canonical form", () => {
    for (const [method, path] of [
      ["GET", "/v1/wallets/"],
      ["GET", "/v1//wallets"],
      ["GET", "/v1/./wallets"],
      ["GET", "/v1/x/../wallets"],
      ["GET", "/v1/wallets/wal%5F1"],
      ["GET", "/v1/wallets/wal_1#x"],
      ["GET", "v1/wallets/wal_1"],
      ["GET", "/v1/wallet"],
      ["GET", "/v1/walletsx"],
      ["GET", "/v1/wallets/wal_1/extra"],
      ["get", "/v1/wallets/wal_1"],
      ["POST", "/v1/wallets/wal_1"],
    ]) {
      assert.equal(admit("privy", method, path), "endpoint_not_allowed", `${method} ${path}`);
    }
  });

  it("allows only declared query names, each once with a well-formed value", () => {
    assert.equal(
      admit("fireblocks", "GET", "/v1/vault/accounts_paged?limit=10&namePrefix=a%20b+c"),
      "fireblocks read /v1/vault/accounts_paged api"
    );
    for (const path of [
      "/v1/supported_assets?limit=10",
      "/v1/vault/accounts_paged?other=1",
      "/v1/vault/accounts_paged?limit=1&limit=2",
      "/v1/vault/accounts_paged?",
      "/v1/vault/accounts_paged?limit=",
      "/v1/vault/accounts_paged?limit=1;2",
      "/v1/vault/accounts_paged?limit=a b",
      "/v1/vault/accounts_paged?limit=%zz",
    ]) {
      assert.equal(admit("fireblocks", "GET", path), "endpoint_not_allowed", path);
    }
  });

  it("accepts a path parameter only in its declared format", () => {
    assert.equal(
      admit("fireblocks", "GET", "/v1/vault/accounts/12/SOL_TEST/addresses_paginated"),
      "fireblocks read /v1/vault/accounts/{vault}/{asset}/addresses_paginated api,cron"
    );
    const token = "Tx_9-".repeat(51);
    assert.equal(
      admit("fireblocks", "GET", `/v1/transactions/${token}`),
      "fireblocks read /v1/transactions/{transaction} api,cron"
    );
    for (const path of [
      "/v1/vault/accounts/abc/SOL/addresses_paginated",
      "/v1/vault/accounts/12/BTC/addresses_paginated",
      "/v1/vault/accounts/12/sol/addresses_paginated",
      `/v1/transactions/${token}a`,
    ]) {
      assert.equal(admit("fireblocks", "GET", path), "endpoint_not_allowed", path);
    }
  });

  it("requires the declared body field to hold an allowed value and ignores other fields", () => {
    assert.equal(
      transaction('{"externalTxId":"t1","operation":"TRANSFER","note":"x"}'),
      "fireblocks change /v1/transactions operation=TRANSFER api"
    );
    for (const body of ['{"operation":"BURN"}', '{"externalTxId":"t1"}']) {
      assert.equal(transaction(body), "body_not_allowed", body);
    }
  });

  it("refuses a body with another key that names the ruled field in a different case", () => {
    assert.equal(transaction('{"operation":"RAW","Operation":"TRANSFER"}'), "body_not_allowed");
    assert.equal(rpc('{"method":"signMessage","METHOD":"signMessage"}'), "body_not_allowed");
  });

  it("refuses a body that is not exactly what JSON.stringify writes", () => {
    for (const body of [
      ' {"operation":"RAW"}',
      '{"operation":"RAW","operation":"RAW"}',
      '{"\\u006fperation":"RAW"}',
      '{"operation":"RAW"',
      "",
    ]) {
      assert.equal(transaction(body), "body_not_allowed", body);
    }
  });

  it("accepts any body on an endpoint without a body rule", () => {
    for (const body of ["not json", ""]) {
      assert.equal(admit("privy", "POST", "/v1/wallets", body), "privy change /v1/wallets api");
    }
  });

  it("lets the body pick between declarations that share a method and path", () => {
    const fireblocksSign = "fireblocks sign /v1/transactions operation=RAW|PROGRAM_CALL api,cron";
    assert.equal(
      transaction('{"operation":"TRANSFER"}'),
      "fireblocks change /v1/transactions operation=TRANSFER api"
    );
    assert.equal(transaction('{"operation":"RAW"}'), fireblocksSign);
    assert.equal(transaction('{"operation":"PROGRAM_CALL"}'), fireblocksSign);

    assert.equal(
      rpc('{"method":"signTransaction"}'),
      "privy sign /v1/wallets/{wallet}/rpc method=signTransaction api,cron"
    );
    assert.equal(
      rpc('{"method":"signMessage"}'),
      "privy sign /v1/wallets/{wallet}/rpc method=signMessage api,cron"
    );
  });
});

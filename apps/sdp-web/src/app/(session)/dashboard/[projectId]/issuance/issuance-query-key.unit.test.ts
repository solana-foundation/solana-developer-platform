import { describe, expect, it } from "vitest";
import { DEFAULT_ISSUANCE_LIST_QUERY } from "./issuance-list-query";
import { issuanceQueryKeys } from "./issuance-query-key";

const parameterizedKeys: [key: readonly unknown[], params: unknown[]][] = [
  [issuanceQueryKeys.tokens({ query: DEFAULT_ISSUANCE_LIST_QUERY }), [DEFAULT_ISSUANCE_LIST_QUERY]],
  [issuanceQueryKeys.authorityWallets({ tokenId: "token_1" }), ["token_1"]],
];

describe("issuance query keys", () => {
  it("gives every key a unique cache prefix", () => {
    const prefixes = [
      issuanceQueryKeys.createTokenSignerWallets(),
      ...parameterizedKeys.map(([key]) => key[0]),
    ];
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("carries every param into the cache identity", () => {
    for (const [key, params] of parameterizedKeys) {
      for (const param of params) {
        expect(key).toContain(param);
      }
    }
  });
});

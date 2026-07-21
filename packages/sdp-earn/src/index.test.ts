import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SdpEarnError } from "./errors";
import { EARN_PROVIDER_CLIENTS, isEarnProviderId, resolveEarnProviderClient } from "./index";

describe("isEarnProviderId", () => {
  it("accepts every registered provider", () => {
    for (const provider of Object.keys(EARN_PROVIDER_CLIENTS)) {
      assert.equal(isEarnProviderId(provider), true);
    }
  });

  it("rejects unknown ids", () => {
    assert.equal(isEarnProviderId("morpho"), false);
    assert.equal(isEarnProviderId(""), false);
  });

  it("rejects prototype-chain keys", () => {
    assert.equal(isEarnProviderId("toString"), false);
    assert.equal(isEarnProviderId("constructor"), false);
    assert.equal(isEarnProviderId("__proto__"), false);
  });
});

describe("resolveEarnProviderClient", () => {
  it("returns the registered singleton", () => {
    assert.equal(resolveEarnProviderClient("veda"), EARN_PROVIDER_CLIENTS.veda);
  });

  it("fails closed with PROVIDER_NOT_CONFIGURED for a drifted provider id", () => {
    for (const drifted of ["retired-provider", "toString", "constructor"]) {
      assert.throws(
        () => resolveEarnProviderClient(drifted),
        (error: unknown) =>
          error instanceof SdpEarnError &&
          error.code === "PROVIDER_NOT_CONFIGURED" &&
          error.statusCode === 503
      );
    }
  });
});

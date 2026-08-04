import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EARN_PROVIDERS } from "@sdp/types/provider-access";
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

// `satisfies Record<EarnProviderId, ...>` already forces registry completeness
// at compile time; this guards the registration points the compiler cannot see
// (package.json subpath exports) and the client/registry-key pairing.
describe("provider registry consistency", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { exports: Record<string, unknown> };

  it("registers a client for every id in EARN_PROVIDERS", () => {
    for (const provider of EARN_PROVIDERS) {
      assert.equal(EARN_PROVIDER_CLIENTS[provider]?.provider, provider);
    }
  });

  it("exposes a package subpath export for every provider client", () => {
    for (const provider of EARN_PROVIDERS) {
      assert.ok(
        Object.hasOwn(packageJson.exports, `./providers/${provider}/client`),
        `package.json is missing the "./providers/${provider}/client" exports entry`
      );
    }
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

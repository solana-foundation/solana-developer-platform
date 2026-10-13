import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RAMP_PROVIDERS, RETIRED_RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { SdpPaymentsError } from "../errors";
import { isRampProviderId, RAMP_PROVIDER_CLIENTS, resolveRampProviderClient } from "./index";

function assertProviderNotConfigured(provider: string): void {
  assert.throws(
    () => resolveRampProviderClient(provider),
    (error: unknown) =>
      error instanceof SdpPaymentsError &&
      error.code === "PROVIDER_NOT_CONFIGURED" &&
      error.statusCode === 503
  );
}

describe("resolveRampProviderClient", () => {
  it("resolves every live provider to its registered client", () => {
    for (const provider of RAMP_PROVIDERS) {
      assert.equal(isRampProviderId(provider), true);
      assert.equal(resolveRampProviderClient(provider), RAMP_PROVIDER_CLIENTS[provider]);
      assert.equal(resolveRampProviderClient(provider).id, provider);
    }
  });

  it("answers 503 for a retired provider", () => {
    for (const provider of RETIRED_RAMP_PROVIDERS) {
      assert.equal(isRampProviderId(provider), false);
      assertProviderNotConfigured(provider);
    }
  });

  it("answers 503 for an unknown id, prototype keys included", () => {
    for (const provider of ["not-a-provider", "", "toString", "constructor", "__proto__"]) {
      assert.equal(isRampProviderId(provider), false);
      assertProviderNotConfigured(provider);
    }
  });

  it("never lists an id as both live and retired", () => {
    const live = new Set<string>(RAMP_PROVIDERS);
    assert.deepEqual(
      RETIRED_RAMP_PROVIDERS.filter((provider) => live.has(provider)),
      []
    );
  });
});

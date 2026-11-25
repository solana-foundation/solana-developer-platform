import { webcrypto } from "node:crypto";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";

/** A provisioning runtime with real crypto and clock, no sleeps, and `fetch` as the only network. */
export function testRuntime(
  fetch: CustodyProvisioningRuntime["fetch"]
): CustodyProvisioningRuntime {
  return {
    fetch,
    sleep: async () => {},
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
    getRandomValues: (data) => webcrypto.getRandomValues(new Uint8Array(data)),
    sha256: async (data) => webcrypto.subtle.digest("SHA-256", new Uint8Array(data)),
  };
}

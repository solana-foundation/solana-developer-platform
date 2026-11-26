import type { CustodyProvisioningRuntime } from "#/shared/runtime";

/** A provisioning runtime with the real clock, no sleeps, and `fetch` as the only network. */
export function testRuntime(
  fetch: CustodyProvisioningRuntime["fetch"]
): CustodyProvisioningRuntime {
  return {
    fetch,
    sleep: async () => {},
    now: Date.now,
  };
}

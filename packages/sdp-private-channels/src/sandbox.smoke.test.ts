/**
 * External smoke test: probe the public SPC sandbox gateway to confirm the
 * transport client still works end-to-end against a real deployment.
 *
 * Opt-in via SDP_PRIVATE_CHANNELS_SMOKE=1 (root: `pnpm test:private-channels`).
 * Skipped by default so a sandbox outage doesn't fail CI or normal test runs.
 */

import { describe, expect, it } from "vitest";
import { SANDBOX_DEFAULTS } from "./constants";
import { probeGatewayHealth } from "./health";

const RUN_SMOKE =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.SDP_PRIVATE_CHANNELS_SMOKE === "1";

describe.skipIf(!RUN_SMOKE)("Private Channels sandbox smoke", () => {
  it("probes the sandbox gateway as ready", async () => {
    const result = await probeGatewayHealth(SANDBOX_DEFAULTS.gatewayUrl);
    expect(result.status).toBe("ready");
  });
});

import { SDP_RAMP_PROVIDER_STAGES, SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { noopObservability } from "@/runtime/observability";
import { env as baseEnv } from "@/test/helpers/env";

vi.mock(import("@sdp/types/release-channels"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    isModuleInReleaseChannel: (releaseChannel, module, rampProviderStages) =>
      module !== "custody" &&
      original.isModuleInReleaseChannel(releaseChannel, module, rampProviderStages),
  };
});

const CUSTODY_PROBE_PATHS = ["/v1/wallets", "/internal/dashboard/custody/connections"] as const;

const app = createApp({
  observability: noopObservability,
  rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
});

let clientAddress = 0;
function nextClientHeaders() {
  clientAddress += 1;
  return { "x-forwarded-for": `10.2.${Math.floor(clientAddress / 256)}.${clientAddress % 256}` };
}

describe("custody routes with the custody module out of channel", () => {
  describe.each(SDP_RELEASE_CHANNEL_NAMES)("on the %s release channel", (releaseChannel) => {
    it.each(CUSTODY_PROBE_PATHS)("refuses an anonymous GET %s before auth", async (path) => {
      const response = await app.request(
        path,
        { headers: nextClientHeaders() },
        { ...baseEnv, SDP_RELEASE_CHANNEL: releaseChannel, TRUST_PROXY_HEADERS: "true" }
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: {
          code: "FORBIDDEN",
          message: "The custody module is not available in this release channel.",
        },
        meta: { requestId: expect.any(String) },
      });
    });
  });
});

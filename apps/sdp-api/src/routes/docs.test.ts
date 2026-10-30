import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { stubReleaseChannel } from "@/test/helpers/release-channel";
import type { Env } from "@/types/env";
import { docs } from "./docs";

const developmentEnv: Env = {
  ENVIRONMENT: "development",
  API_VERSION: "v1",
};

describe("API docs route", () => {
  it("redirects the canonical stable API to the generated docs reference", async () => {
    stubReleaseChannel("stable");
    const response = await docs.request("https://api.solana.com/", {}, developmentEnv);

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://platform.solana.com/docs/reference/api");
  });

  it("keeps Swagger UI for other hosts and release channels", async () => {
    const hostsAndChannels: [string, SdpReleaseChannel][] = [
      ["https://api-stage.solana.com/", "stable"],
      ["https://api.solana.com/", "beta"],
    ];
    for (const [url, releaseChannel] of hostsAndChannels) {
      stubReleaseChannel(releaseChannel);
      const response = await docs.request(url, {}, developmentEnv);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('url: "/openapi.json"');
    }
  });
});

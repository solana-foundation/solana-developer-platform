import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { docs } from "./docs";

const stableEnv: Env = {
  ENVIRONMENT: "development",
  API_VERSION: "v1",
  SDP_RELEASE_CHANNEL: "stable",
};

describe("API docs route", () => {
  it("redirects the canonical stable API to the generated docs reference", async () => {
    const response = await docs.request("https://api.solana.com/", {}, stableEnv);

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://platform.solana.com/docs/reference/api");
  });

  it("keeps Swagger UI for other hosts and release channels", async () => {
    for (const [url, releaseChannel] of [
      ["https://api-stage.solana.com/", "stable"],
      ["https://api.solana.com/", "beta"],
    ]) {
      const response = await docs.request(
        url,
        {},
        {
          ...stableEnv,
          SDP_RELEASE_CHANNEL: releaseChannel,
        }
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('url: "/openapi.json"');
    }
  });

  it("loads one pinned Swagger UI release with subresource integrity", async () => {
    const response = await docs.request("https://api-stage.solana.com/", {}, stableEnv);
    const page = await response.text();
    const assets = [...page.matchAll(/(?:href|src)="(https:\/\/unpkg\.com\/[^"]+)"/g)];

    expect(assets).toHaveLength(2);
    for (const [, url] of assets) {
      expect(url).toMatch(/^https:\/\/unpkg\.com\/swagger-ui-dist@\d+\.\d+\.\d+\//);
    }
    expect(page.match(/integrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/g)).toHaveLength(2);
    expect(page.match(/crossorigin="anonymous"/g)).toHaveLength(2);
  });
});

import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import type { Env } from "@/types/env";
import { createWeakEtag, openapi } from "./openapi";

const appEnv = {
  ENVIRONMENT: "development",
  API_VERSION: "v1",
  SDP_RELEASE_CHANNEL: "experimental",
} as Env;

const stableEnv = { SDP_RELEASE_CHANNEL: "stable" } as Env;

describe("OpenAPI response delivery", () => {
  it("hashes UTF-8 bytes for portable validators", () => {
    expect(createWeakEtag("café → api")).toBe('W/"b8f938af-13"');
  });

  it("serves the pre-serialized document with aggressive cache validators", async () => {
    const response = await openapi.request("/", {}, stableEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=UTF-8");
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800"
    );
    expect(response.headers.get("ETag")).toMatch(/^W\/"[a-f0-9]+-[0-9]+"$/);
    expect((await response.json()).openapi).toBe("3.0.3");
  });

  it("returns 304 for a matching document validator", async () => {
    const initial = await openapi.request("/", {}, stableEnv);
    const etag = initial.headers.get("ETag");
    expect(etag).toBeTruthy();

    const response = await openapi.request(
      "/",
      { headers: { "If-None-Match": `W/"not-current", ${etag?.replace(/^W\//, "")}` } },
      stableEnv
    );

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=86400");
  });

  it("lets the real app pretty-print /openapi.json without a stale body length", async () => {
    const app = createApp({ rampProviderStages: SDP_RAMP_PROVIDER_STAGES });
    const response = await app.request("http://local.test/openapi.json?pretty", {}, appEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBeNull();
    const body = await response.text();
    expect(body).toContain('\n  "openapi": "3.0.3"');
    expect(JSON.parse(body).openapi).toBe("3.0.3");
  });

  it("documents only the routes the deployment's release channel serves", async () => {
    const paths = async (releaseChannel: string) =>
      Object.keys(
        (
          await (
            await openapi.request("/", {}, { SDP_RELEASE_CHANNEL: releaseChannel } as Env)
          ).json()
        ).paths
      );
    const stable = await paths("stable");
    const experimental = await paths("experimental");

    expect(stable).toContain("/v1/payments/transfers");
    expect(stable.filter((path) => path.startsWith("/v1/issuance"))).toEqual([]);
    expect(experimental).toContain("/v1/issuance/tokens");
  });

  it("gives each release channel's document its own validator", async () => {
    const etag = async (releaseChannel: string) =>
      (await openapi.request("/", {}, { SDP_RELEASE_CHANNEL: releaseChannel } as Env)).headers.get(
        "ETag"
      );

    expect(await etag("stable")).not.toBe(await etag("experimental"));
  });
});

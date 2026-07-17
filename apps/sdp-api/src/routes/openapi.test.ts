import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import type { MonitorOptions, Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";
import openapi from "./openapi";

const observability: Observability = {
  captureException: () => {},
  withScope: () => {},
  withMonitor: <T>(_slug: string, fn: () => Promise<T>, _opts: MonitorOptions) => fn(),
};

const appEnv = {
  ENVIRONMENT: "development",
  API_VERSION: "v1",
  SDP_RUNTIME: "node",
} as Env;

describe("OpenAPI response delivery", () => {
  it("serves the pre-serialized document with aggressive cache validators", async () => {
    const response = await openapi.request("/");

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
    const initial = await openapi.request("/");
    const etag = initial.headers.get("ETag");
    expect(etag).toBeTruthy();

    const response = await openapi.request("/", {
      headers: { "If-None-Match": `W/"not-current", ${etag?.replace(/^W\//, "")}` },
    });

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=86400");
  });

  it("lets the real app pretty-print /openapi.json without a stale body length", async () => {
    const app = createApp({ observability });
    const response = await app.request("http://local.test/openapi.json?pretty", {}, appEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBeNull();
    const body = await response.text();
    expect(body).toContain('\n  "openapi": "3.0.3"');
    expect(JSON.parse(body).openapi).toBe("3.0.3");
  });
});

import { SDP_RAMP_PROVIDER_MATURITY, SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

const inScope = (path: string) =>
  /^\/(?:health(?:\/ready)?|openapi\.json|docs|llms\.txt)?$/.test(path);
describe("Health and API discovery CLI contracts", () => {
  it("documents all six existing GET routes with public authentication", () => {
    const app = createApp({ rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY });
    const runtime = new Set(
      app.routes
        .filter((route) => route.method === "GET" && inScope(route.path))
        .map((route) => route.path)
    );
    const documented = Object.entries(createOpenApiDocument().paths).filter(
      ([path, item]) => inScope(path) && item.get !== undefined
    );
    expect(documented.map(([path]) => path).sort()).toEqual([...runtime].sort());
    expect(documented).toHaveLength(6);
    for (const [, item] of documented) {
      expect(item.get?.security).toEqual([]);
      expect(item.get?.requestBody).toBeUndefined();
    }
  });
  it("keeps health public without promoting discovery endpoints or hidden API families", () => {
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
      const document = createPublicOpenApiDocument({ releaseChannel });
      expect(Object.keys(document.paths).filter(inScope).sort()).toEqual([
        "/health",
        "/health/ready",
      ]);
      expect(document.paths["/health"]?.get?.security).toEqual([]);
      expect(document.tags?.some((tag) => tag.name === "API Discovery")).toBe(false);
    }
  });
  it("pins readiness status to its HTTP response and preserves the diagnostic body", () => {
    const operation = createOpenApiDocument().paths["/health/ready"]?.get;
    for (const [status, value] of [
      ["200", "ready"],
      ["503", "not_ready"],
    ])
      expect(operation?.responses[status]).toMatchObject({
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["status", "timestamp", "revision", "commit", "checks"],
              properties: {
                status: { enum: [value] },
                checks: { required: ["database", "redis"] },
              },
            },
          },
        },
      });
  });
  it("documents conditional OpenAPI, both text media types, and the exact root Location", () => {
    const document = createOpenApiDocument();
    const operation = document.paths["/openapi.json"]?.get;
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: "header", name: "If-None-Match", required: false }),
      ])
    );
    expect(operation?.responses["200"]).toMatchObject({
      headers: { ETag: { schema: { type: "string" } } },
      content: { "application/json": { schema: { required: ["openapi", "info", "paths"] } } },
    });
    expect(operation?.responses["304"]).toMatchObject({
      headers: { ETag: { schema: { type: "string" } } },
    });
    expect(operation?.responses["304"]).not.toHaveProperty("content");
    expect(document.paths["/docs"]?.get?.responses["200"]).toMatchObject({
      content: { "text/html": { schema: { type: "string" } } },
    });
    expect(document.paths["/llms.txt"]?.get?.responses["200"]).toMatchObject({
      content: { "text/plain": { schema: { type: "string" } } },
    });
    expect(document.paths["/"]?.get?.responses["302"]).toMatchObject({
      headers: { Location: { schema: { type: "string", enum: ["/health"] } } },
    });
  });
});

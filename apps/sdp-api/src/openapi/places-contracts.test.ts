import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { places } from "@/routes/places";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

describe("Places and address-lookup CLI contracts", () => {
  it("documents all three mounted routes and keeps them internal on every channel", () => {
    const methods = ["get", "post"] as const;
    const runtime = new Set(
      places.routes
        .filter((route) => methods.some((method) => method.toUpperCase() === route.method))
        .map(
          (route) => `${route.method} /v1/places${route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`
        )
    );
    const documented = Object.entries(createOpenApiDocument().paths)
      .filter(([path]) => path.startsWith("/v1/places/"))
      .flatMap(([path, item]) =>
        methods.flatMap((method) =>
          item[method] === undefined ? [] : [`${method.toUpperCase()} ${path}`]
        )
      );
    expect(documented.sort()).toEqual([...runtime].sort());
    expect(documented).toHaveLength(3);
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES)
      expect(
        Object.keys(createPublicOpenApiDocument({ releaseChannel }).paths).filter((path) =>
          path.startsWith("/v1/places/")
        )
      ).toEqual([]);
  });
  it("requires explicit lookup session tokens and supports PNG with JSON errors", () => {
    const document = createOpenApiDocument();
    expect(document.paths["/v1/places/autocomplete"]?.post?.requestBody).toMatchObject({
      required: true,
      content: { "application/json": { schema: { required: ["input", "sessionToken"] } } },
    });
    expect(document.paths["/v1/places/{placeId}"]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sessionToken", in: "query", required: true }),
      ])
    );
    expect(document.paths["/v1/places/static-map"]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "latitude", in: "query", required: true }),
        expect.objectContaining({ name: "longitude", in: "query", required: true }),
      ])
    );
    expect(document.paths["/v1/places/static-map"]?.get?.responses["200"]).toMatchObject({
      content: { "image/png": { schema: { type: "string", format: "binary" } } },
    });
    expect(document.paths["/v1/places/static-map"]?.get?.responses["429"]).toMatchObject({
      content: { "application/json": expect.anything() },
    });
  });
  it("declares manage permission without project or replay headers on every route", () => {
    for (const [path, item] of Object.entries(createOpenApiDocument().paths)) {
      if (!path.startsWith("/v1/places/")) continue;
      for (const method of ["get", "post"] as const) {
        const operation = item[method];
        if (operation === undefined) continue;
        expect(operation.security).toEqual([{ apiKeyAuth: [] }, { clerkBearerAuth: [] }]);
        expect(operation.parameters?.filter((p) => "in" in p && p.in === "header") ?? []).toEqual(
          []
        );
        expect(operation.responses["403"]).toMatchObject({
          description: expect.stringContaining("counterparties.manage"),
        });
      }
    }
  });
});

import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { dvp } from "@/routes/dvp";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

describe("DvP internal API coverage", () => {
  it("documents every mounted operation, including mint inspection", () => {
    const internal = createOpenApiDocument();
    const methods = ["get", "post", "put", "patch", "delete"] as const;
    const runtime = dvp.routes
      .filter((route) => methods.some((method) => method.toUpperCase() === route.method))
      .map((route) => `${route.method} /v1/dvp${route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`);
    const documented = Object.entries(internal.paths)
      .filter(([path]) => path.startsWith("/v1/dvp/"))
      .flatMap(([path, item]) =>
        methods.flatMap((method) => {
          const operation = item[method];
          if (operation === undefined) return [];
          expect(operation.operationId).toBeDefined();
          expect(operation.security).toEqual([{ apiKeyAuth: [] }]);
          expect(Object.keys(operation.responses)).toContain(
            method === "post" && path === "/v1/dvp/trades" ? "201" : "200"
          );
          return [`${method.toUpperCase()} ${path}`];
        })
      );
    expect(documented.sort()).toEqual([...new Set(runtime)].sort());
    expect(documented).toHaveLength(9);
  });

  it("keeps every DvP operation out of public documents on every release channel", () => {
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
      const published = createPublicOpenApiDocument({ releaseChannel });
      expect(Object.keys(published.paths).filter((path) => path.startsWith("/v1/dvp/"))).toEqual(
        []
      );
    }
  });
});

import { describe, expect, it } from "vitest";
import earnRoutes from "@/routes/earn";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

describe("Earn API contract coverage", () => {
  it("documents every mounted Earn operation internally, with an operation id and response", () => {
    const document = createOpenApiDocument();
    const runtime = new Set(
      earnRoutes.routes
        .filter((route) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(route.method))
        .map(
          (route) => `${route.method} /v1/earn${route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`
        )
    );
    const documented = new Set(
      Object.entries(document.paths)
        .filter(([path]) => path.startsWith("/v1/earn/"))
        .flatMap(([path, item]) =>
          Object.entries(item)
            .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
            .map(([method, operation]) => {
              expect(operation).toHaveProperty("operationId");
              expect(operation).toHaveProperty("responses.200");
              return `${method.toUpperCase()} ${path}`;
            })
        )
    );
    expect([...documented].sort()).toEqual([...runtime].sort());
  });

  it("keeps every Treasury operation authenticated and unpublished", () => {
    const internal = createOpenApiDocument();
    const published = createPublicOpenApiDocument();
    for (const [path, item] of Object.entries(internal.paths)) {
      if (!path.startsWith("/v1/earn/")) continue;
      expect(published.paths[path]).toBeUndefined();
      if (
        path.includes("external-wallet") ||
        path.includes("strategies") ||
        path.endsWith("vault-deposit-previews")
      )
        continue;
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "put"].includes(method)) continue;
        expect(operation).toHaveProperty("security");
        expect((operation as { security: object[] }).security).not.toContainEqual({});
      }
    }
  });
});

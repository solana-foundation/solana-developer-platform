import { describe, expect, it } from "vitest";
import { earnRoutes } from "@/routes/earn";
import { operations } from "@/routes/operations";
import { EARN_GROUPS } from "./paths/earn-groups";
import { DOCS_GROUP } from "./paths/helpers";
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
              expect(operation).not.toHaveProperty("responses.410");
              return `${method.toUpperCase()} ${path}`;
            })
        )
    );
    expect([...documented].sort()).toEqual([...runtime].sort());
  });

  it("keeps every Earn operation authenticated and internal groups out of the public document", () => {
    const internal = createOpenApiDocument();
    const published = createPublicOpenApiDocument({ releaseChannel: "experimental" });
    for (const [path, item] of Object.entries(internal.paths)) {
      if (!path.startsWith("/v1/earn/")) continue;
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = item[method];
        if (!operation) continue;
        expect(operation.security).toBeDefined();
        expect(operation.security).not.toContainEqual({});
        expect(published.paths[path]?.[method]).toBeUndefined();
      }
    }
  });

  it("groups every Earn operation for the reference without changing its publication scope", () => {
    const groups = new Set<string>();
    const internal = createOpenApiDocument();
    for (const [path, item] of Object.entries(internal.paths)) {
      if (!path.startsWith("/v1/earn/")) continue;
      for (const method of ["get", "post", "put"] as const) {
        const operation = item[method];
        if (!operation) continue;
        const group = operation[DOCS_GROUP];
        expect(Object.values(EARN_GROUPS)).toContain(group);
        if (typeof group === "string") groups.add(group);
      }
    }
    expect([...groups].sort()).toEqual(Object.values(EARN_GROUPS).sort());

    const published = createPublicOpenApiDocument({ releaseChannel: "experimental" });
    expect(Object.keys(published.paths).filter((path) => path.startsWith("/v1/earn"))).toEqual([]);
  });

  it("documents lifecycle routes internally without publishing the replacement contract", () => {
    const internal = createOpenApiDocument();
    const mounted = [
      ...new Set(
        operations.routes
          .filter((route) => ["GET", "POST"].includes(route.method))
          .map(
            (route) =>
              `${route.method} /v1/operations${route.path === "/" ? "" : route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`
          )
      ),
    ].sort();
    const documented = Object.entries(internal.paths)
      .filter(([path]) => path.startsWith("/v1/operations"))
      .flatMap(([path, item]) =>
        Object.entries(item)
          .filter(([method]) => ["get", "post"].includes(method))
          .map(([method]) => `${method.toUpperCase()} ${path}`)
      )
      .sort();
    expect(documented).toEqual(mounted);
    for (const releaseChannel of ["stable", "beta", "experimental"] as const) {
      const published = createPublicOpenApiDocument({ releaseChannel });
      for (const path of [
        "/v1/earn/discovery",
        "/v1/earn/positions",
        "/v1/earn/deposit",
        "/v1/earn/withdraw",
        ...Object.keys(internal.paths).filter((path) => path.startsWith("/v1/operations")),
      ])
        expect(published.paths[path]).toBeUndefined();
    }
  });
});

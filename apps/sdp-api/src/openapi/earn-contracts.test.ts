import { describe, expect, it } from "vitest";
import { earnRoutes } from "@/routes/earn";
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
        if (
          operation[DOCS_GROUP] !== EARN_GROUPS.discovery &&
          operation[DOCS_GROUP] !== EARN_GROUPS.embeddedYield
        ) {
          expect(published.paths[path]?.[method]).toBeUndefined();
        }
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

    const partner = createPublicOpenApiDocument({
      releaseChannel: "experimental",
    });
    for (const [path, item] of Object.entries(partner.paths)) {
      if (!path.startsWith("/v1/earn/")) continue;
      for (const method of ["get", "post"] as const) {
        const operation = item[method];
        if (!operation) continue;
        expect([EARN_GROUPS.discovery, EARN_GROUPS.embeddedYield]).toContain(operation[DOCS_GROUP]);
      }
    }
  });
});
